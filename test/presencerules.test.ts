import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { openDb } from '../server/db.ts';
import { createEngine, PsimError } from '../server/engine.ts';
import type { PresenceChange } from '../server/presence.ts';
import type { FaceSeen } from '../server/faceobs.ts';
import { createRuleMachine, createRules, describeRule, faceMatches, faceMismatch, validateSpec, whoNeedsReview } from '../server/rules.ts';
import type { RuleAction, RuleSpec, Who } from '../server/rules.ts';
import { seedDemo } from '../server/seed.ts';

// Lundi 12 octobre 2026, minuit, heure locale du serveur (les plages horaires se lisent en heure locale).
const T0 = new Date(2026, 9, 12, 0, 0, 0).getTime();
const S = 1000;
const MIN = 60 * S;
const at = (sec: number): number => T0 + sec * S;
/** Secondes depuis T0 : jour, heure, minute, seconde. */
const hms = (day: number, h: number, m = 0, s = 0): number => day * 86400 + h * 3600 + m * 60 + s;

const KNOWN = {
  cameraIds: new Set(['C-01', 'C-02', 'C-03', 'C-04', 'C-05']),
  zones: new Set(['Accueil', 'Couloir', 'Salle serveurs', 'Entrepot', 'Atelier']),
};

/**
 * Appareils des cameras de test : C-01 et C-02 sont deux voies du MEME enregistreur (une seule base de visages), C-03 est une
 * camera IP a part, C-04 un troisieme appareil ; C-05 n'a pas de source video. Meme table pour la machine (hostOf injecte) et
 * pour camera_source (moteur complet, voir faceSetup).
 */
const HOSTS: Record<string, string> = { 'C-01': '192.0.2.10', 'C-02': '192.0.2.10', 'C-03': '192.0.2.20', 'C-04': '192.0.2.30' };
const hostOf = (cameraId: string): string | null => HOSTS[cameraId] ?? null;

const spec = (over: Partial<RuleSpec> = {}): RuleSpec => ({
  who: { type: 'anyone' },
  where: { cameras: ['C-01'] },
  when: { type: 'always' },
  trigger: { type: 'appears' },
  then: { severity: 'critical' },
  cooldownMinutes: 10,
  ...over,
});
const stays = (minutes: number, over: Partial<RuleSpec> = {}): RuleSpec => spec({ trigger: { type: 'stays', minutes }, ...over });
const night = (days = [0, 1, 2, 3, 4, 5, 6]): RuleSpec['when'] => ({ type: 'windows', windows: [{ days, from: '22:00', to: '06:00' }] });

// ---- 1. Validation -----------------------------------------------------------------------------------------------

describe('regles de presence : validation de la specification', () => {
  const refuse = (input: unknown, pattern: RegExp) =>
    assert.throws(
      () => validateSpec(input, KNOWN),
      (e: unknown) => e instanceof PsimError && e.status === 400 && pattern.test(e.message),
      `devait etre refusee : ${JSON.stringify(input)}`,
    );

  it('accepte une regle complete et la normalise (repos par defaut, doublons retires, copie profonde)', () => {
    const input = {
      who: { type: 'anyone' },
      where: { cameras: ['C-01', 'C-02', 'C-01'] },
      when: { type: 'windows', windows: [{ days: [5, 1, 1, 3], from: '22:00', to: '06:00' }] },
      trigger: { type: 'stays', minutes: 15 },
      then: { severity: 'warning' },
    };
    const out = validateSpec(input, KNOWN);
    assert.deepEqual(out, {
      who: { type: 'anyone' },
      where: { cameras: ['C-01', 'C-02'] },
      when: { type: 'windows', windows: [{ days: [1, 3, 5], from: '22:00', to: '06:00' }] },
      trigger: { type: 'stays', minutes: 15 },
      then: { severity: 'warning' },
      cooldownMinutes: 10,
    });
    // copie : modifier l'entree ensuite ne change pas le resultat
    input.where.cameras.push('C-03');
    input.when.windows[0].days.push(6);
    assert.deepEqual(out.where, { cameras: ['C-01', 'C-02'] });
    assert.deepEqual((out.when as { windows: { days: number[] }[] }).windows[0].days, [1, 3, 5]);
  });

  it('accepte des zones, « toujours », « zone armee », les bornes 0..1440 et 1..1440', () => {
    assert.deepEqual(validateSpec(spec({ where: { zones: ['Accueil', 'Atelier', 'Accueil'] }, when: { type: 'armed' } }), KNOWN).where, { zones: ['Accueil', 'Atelier'] });
    assert.equal(validateSpec(spec({ cooldownMinutes: 0 }), KNOWN).cooldownMinutes, 0);
    assert.equal(validateSpec(spec({ cooldownMinutes: 1440 }), KNOWN).cooldownMinutes, 1440);
    assert.deepEqual(validateSpec(stays(1), KNOWN).trigger, { type: 'stays', minutes: 1 });
    assert.deepEqual(validateSpec(stays(1440), KNOWN).trigger, { type: 'stays', minutes: 1440 });
    const { cooldownMinutes: _omitted, ...withoutCooldown } = spec();
    assert.equal(validateSpec(withoutCooldown, KNOWN).cooldownMinutes, 10);
  });

  it("refuse ce qui n'est pas un objet simple", () => {
    for (const bad of [null, undefined, 'regle', 12, [], [spec()]]) refuse(bad, /objet est attendu/);
    refuse(Object.create(spec()), /objet est attendu/); // proprietes heritees : jamais lues
  });

  it('refuse les champs inconnus ou superflus, a chaque niveau', () => {
    refuse({ ...spec(), extra: 1 }, /champ « extra » non reconnu/);
    refuse(spec({ who: { type: 'anyone', listId: 3 } as never }), /Qui : champ « listId »/);
    refuse(spec({ where: { cameras: ['C-01'], zones: ['Accueil'] } as never }), /cameras OU des zones/);
    refuse(spec({ where: { cameras: ['C-01'], note: 'x' } as never }), /champ « note »/);
    refuse(spec({ when: { type: 'always', windows: [] } as never }), /Quand : champ « windows »/);
    refuse(spec({ when: { type: 'windows', windows: [{ days: [1], from: '22:00', to: '06:00', extra: true }] } as never }), /plage : champ « extra »/);
    refuse(spec({ trigger: { type: 'appears', minutes: 5 } as never }), /Si : champ « minutes »/);
    refuse(spec({ then: { severity: 'critical', sms: true } as never }), /Alors : champ « sms »/);
  });

  it('refuse les cases manquantes et les valeurs hors bornes, avec un message precis', () => {
    const { where: _w, ...noWhere } = spec();
    refuse(noWhere, /Il manque la case « Ou »/);
    refuse(spec({ where: {} as never }), /cameras OU des zones/);
    refuse(spec({ where: { cameras: [] } }), /Ou : choisir au moins une camera/);
    refuse(spec({ where: { cameras: 'C-01' as never } }), /Ou : choisir au moins une camera/);
    refuse(spec({ where: { cameras: ['C-99'] } }), /camera inconnue « C-99 »/);
    refuse(spec({ where: { zones: ['Cave'] } }), /zone inconnue « Cave »/);
    refuse(spec({ where: { cameras: [42 as never] } }), /nom invalide/);
    refuse(spec({ who: { type: 'list' } as never }), /la camera de la liste est requise/);
    refuse(spec({ who: { type: 'everyone' } as never }), /Qui : choisir/);
    refuse(spec({ when: { type: 'sometimes' } as never }), /Quand : choisir/);
    refuse(spec({ when: { type: 'windows', windows: [] } }), /au moins une plage/);
    refuse(spec({ when: { type: 'windows', windows: [{ days: [1], from: '25:00', to: '06:00' }] } }), /heures invalides/);
    refuse(spec({ when: { type: 'windows', windows: [{ days: [7], from: '22:00', to: '06:00' }] } }), /jours invalides/);
    refuse(spec({ when: { type: 'windows', windows: [{ days: [1], from: '22:00', to: '22:00' }] } }), /identiques/);
    for (const minutes of [0, 1441, 1.5, '5', null, NaN, Infinity]) refuse(stays(minutes as never), /duree de presence/);
    refuse(spec({ trigger: { type: 'stays' } as never }), /duree de presence/);
    refuse(spec({ trigger: { type: 'lingers' } as never }), /Si : choisir/);
    refuse(spec({ then: { severity: 'info' } as never }), /Alors : la gravite/);
    for (const cooldownMinutes of [-1, 1441, 2.5, '10', NaN]) refuse(spec({ cooldownMinutes: cooldownMinutes as never }), /Repos/);
  });

  it('ne fait pas confiance aux prototypes (__proto__, constructor)', () => {
    refuse(JSON.parse(`{"__proto__":{"admin":true},"who":{"type":"anyone"},"where":{"cameras":["C-01"]},"when":{"type":"always"},"trigger":{"type":"appears"},"then":{"severity":"critical"}}`), /champ « __proto__ »/);
    refuse({ ...spec(), constructor: { prototype: {} } }, /champ « constructor »/);
    refuse(spec({ where: { cameras: ['__proto__'] } }), /camera inconnue/);
    refuse(spec({ when: { type: '__proto__' } as never }), /Quand : choisir/);
    // un objet « plat » sans prototype est accepte
    const bare = Object.assign(Object.create(null), spec());
    assert.equal(validateSpec(bare, KNOWN).cooldownMinutes, 10);
    assert.equal(({} as Record<string, unknown>).admin, undefined);
  });
});

// ---- 2. Phrase en francais ---------------------------------------------------------------------------------------

describe('regles de presence : phrase en francais', () => {
  const names: Record<string, string> = { 'C-01': 'Avant cour', 'C-02': 'Escalier', 'C-03': 'Portail' };
  const ctx = { cameraName: (id: string) => names[id] ?? id };

  it('une ou plusieurs cameras, toujours, alerte critique, repos au singulier comme au pluriel', () => {
    assert.equal(
      describeRule(spec({ where: { cameras: ['C-01', 'C-02'] } }), ctx),
      "Prévenir (alerte critique) si quelqu'un apparaît devant les caméras « Avant cour » ou « Escalier », à toute heure ; ensuite, attendre 10 min avant de signaler à nouveau.",
    );
    assert.equal(
      describeRule(spec({ cooldownMinutes: 1 }), ctx),
      "Prévenir (alerte critique) si quelqu'un apparaît devant la caméra « Avant cour », à toute heure ; ensuite, attendre 1 min avant de signaler à nouveau.",
    );
    assert.match(describeRule(spec({ where: { cameras: ['C-01', 'C-02', 'C-03'] } }), ctx), /les caméras « Avant cour », « Escalier » ou « Portail »,/);
  });

  it("zones, duree de presence (minutes, heures), avertissement, plages de nuit, repos nul", () => {
    assert.equal(
      describeRule(stays(90, { where: { zones: ['Accueil', 'Atelier'] }, when: night([1, 2, 3, 4, 5]), then: { severity: 'warning' }, cooldownMinutes: 0 }), ctx),
      "Prévenir (avertissement) si quelqu'un reste au moins 1 h 30 dans les zones « Accueil » ou « Atelier », uniquement de 22:00 à 06:00 le lendemain, du lundi au vendredi ; ensuite, signaler à nouveau sans attendre.",
    );
    assert.match(describeRule(stays(45, { where: { zones: ['Accueil'] } }), ctx), /reste au moins 45 min dans la zone « Accueil »/);
    assert.match(describeRule(stays(120), ctx), /reste au moins 2 h devant/);
    assert.match(describeRule(stays(1440, { cooldownMinutes: 1440 }), ctx), /au moins 24 h .*attendre 24 h avant/);
    assert.match(describeRule(stays(65), ctx), /1 h 05/);
  });

  it('zone armee, et jours : tous, semaine, week-end, jours isoles, plusieurs plages', () => {
    assert.match(describeRule(spec({ when: { type: 'armed' } }), ctx), /, uniquement quand la zone est armée ;/);
    const days = (d: number[]) => describeRule(spec({ when: { type: 'windows', windows: [{ days: d, from: '08:00', to: '12:00' }] } }), ctx);
    assert.match(days([0, 1, 2, 3, 4, 5, 6]), /uniquement de 08:00 à 12:00, tous les jours ;/);
    assert.match(days([0, 6]), /, le samedi et le dimanche ;/);
    assert.match(days([4, 1, 2]), /, le lundi, le mardi et le jeudi ;/);
    assert.match(days([1, 2, 3, 5]), /, du lundi au mercredi et le vendredi ;/);
    assert.match(days([3]), /, le mercredi ;/);
    const two = describeRule(spec({ when: { type: 'windows', windows: [{ days: [1], from: '08:00', to: '12:00' }, { days: [2], from: '14:00', to: '18:00' }] } }), ctx);
    assert.match(two, /de 08:00 à 12:00, le lundi ou de 14:00 à 18:00, le mardi ;/);
    // pas de « le lendemain » pour une plage dans la journee
    assert.doesNotMatch(two, /lendemain/);
  });

  it("repli sur l'identifiant si une camera n'a plus de nom", () => {
    assert.match(describeRule(spec({ where: { cameras: ['C-77'] } }), ctx), /« C-77 »/);
  });
});

// ---- 3. Machine a etats (pure) -----------------------------------------------------------------------------------

function machine(s: RuleSpec, armed: Record<string, boolean> = {}) {
  return createRuleMachine(s, { cameras: ['C-01', 'C-02'], isArmed: (cameraId) => armed[cameraId] !== false, hostOf });
}
const change = (sec: number, cameraId: string, kind: 'start' | 'stop') => ({ cameraId, kind, at: at(sec) });
const changeAt = (ms: number, cameraId: string, kind: 'start' | 'stop') => ({ cameraId, kind, at: ms });
/** Actions lisibles : « person_detected:C-01@12 » (12 s apres T0) et « clear@72 ». */
const brief = (actions: RuleAction[]): string[] => actions.map((a) => (a.kind === 'clear' ? `clear@${(a.at - T0) / S}` : `${a.event}:${a.cameraId}@${(a.at - T0) / S}`));

describe('machine de regle : « apparait », fin et lissage de 60 s', () => {
  it("se declenche au premier start, ne repete pas, et se termine 60 s apres le dernier stop (a l'instant exact)", () => {
    const m = machine(spec());
    assert.equal(m.nextWake(), null);
    assert.deepEqual(brief(m.feed(change(0, 'C-01', 'start'))), ['person_detected:C-01@0']);
    assert.deepEqual(brief(m.feed(change(10, 'C-02', 'start'))), [], 'deja declenchee');
    assert.deepEqual(brief(m.feed(change(20, 'C-01', 'stop'))), []);
    assert.deepEqual(brief(m.feed(change(30, 'C-02', 'stop'))), []);
    assert.equal(m.nextWake(), at(90));
    assert.deepEqual(brief(m.tick(at(89))), []);
    assert.equal(m.isTriggered(), true);
    assert.deepEqual(brief(m.tick(at(500))), ['clear@90'], "le clear est date de la fin de la presence, pas du tick");
    assert.equal(m.isTriggered(), false);
    assert.equal(m.nextWake(), null);
  });

  it('un trou de 59 s ne coupe pas la presence ; un trou de 60 s ou 61 s la coupe', () => {
    const run = (gap: number) => {
      const m = machine(spec({ cooldownMinutes: 0 }));
      return brief([
        ...m.feed(change(0, 'C-01', 'start')),
        ...m.feed(change(100, 'C-01', 'stop')),
        ...m.feed(change(100 + gap, 'C-01', 'start')),
        ...m.feed(change(300, 'C-01', 'stop')),
        ...m.tick(at(400)),
      ]);
    };
    assert.deepEqual(run(59), ['person_detected:C-01@0', 'clear@360']);
    assert.deepEqual(run(60), ['person_detected:C-01@0', 'clear@160', 'person_detected:C-01@160', 'clear@360']);
    assert.deepEqual(run(61), ['person_detected:C-01@0', 'clear@160', 'person_detected:C-01@161', 'clear@360']);
  });

  it("la presence est celle de TOUTES les cameras de la portee : un relais d'une camera a l'autre la prolonge", () => {
    const m = machine(spec());
    assert.deepEqual(brief(m.feed(change(0, 'C-01', 'start'))), ['person_detected:C-01@0']);
    assert.deepEqual(brief(m.feed(change(100, 'C-01', 'stop'))), []);
    assert.deepEqual(brief(m.feed(change(130, 'C-02', 'start'))), []);
    assert.deepEqual(brief(m.tick(at(250))), [], 'C-02 est toujours occupee : pas de fin');
    assert.deepEqual(brief(m.feed(change(300, 'C-02', 'stop'))), []);
    assert.deepEqual(brief(m.tick(at(359))), []);
    assert.deepEqual(brief(m.tick(at(360))), ['clear@360']);
  });

  it("ignore les cameras hors portee, les doublons de start et les stop d'une presence inconnue", () => {
    const m = machine(spec());
    assert.deepEqual(brief(m.feed(change(0, 'C-03', 'start'))), []);
    assert.equal(m.nextWake(), null);
    assert.deepEqual(brief(m.feed(change(5, 'C-02', 'stop'))), []);
    assert.equal(m.nextWake(), null);
    assert.deepEqual(brief(m.feed(change(10, 'C-01', 'start'))), ['person_detected:C-01@10']);
    assert.deepEqual(brief(m.feed(change(11, 'C-01', 'start'))), []);
  });

  it("la gravite choisit l'evenement : critical = precis, warning = person_noticed", () => {
    const warn = (s: RuleSpec) => ({ ...s, then: { severity: 'warning' as const } });
    assert.deepEqual(brief(machine(spec()).feed(change(0, 'C-01', 'start'))), ['person_detected:C-01@0']);
    assert.deepEqual(brief(machine(warn(spec())).feed(change(0, 'C-01', 'start'))), ['person_noticed:C-01@0']);
    assert.deepEqual(brief(machine(stays(1)).tick(at(0)).concat(machine(stays(1)).tick(at(1)))), []);
    const lingering = machine(stays(1));
    lingering.feed(change(0, 'C-01', 'start'));
    assert.deepEqual(brief(lingering.tick(at(60))), ['person_lingering:C-01@60']);
    const noticed = machine(warn(stays(1)));
    noticed.feed(change(0, 'C-01', 'start'));
    assert.deepEqual(brief(noticed.tick(at(60))), ['person_noticed:C-01@60']);
  });

  it('le temps ne recule jamais : un changement date du passe est traite a l\'instant courant', () => {
    const m = machine(spec());
    m.tick(at(100));
    assert.deepEqual(brief(m.feed(change(50, 'C-01', 'start'))), ['person_detected:C-01@100']);
  });
});

describe('machine de regle : repos (cooldown)', () => {
  it('aucun redeclenchement avant la fin du repos, puis oui (limite incluse)', () => {
    const a = machine(spec()); // repos 10 min
    assert.deepEqual(brief(a.feed(change(0, 'C-01', 'start'))), ['person_detected:C-01@0']);
    a.feed(change(30, 'C-01', 'stop'));
    assert.deepEqual(brief(a.tick(at(90))), ['clear@90']); // repos jusqu'a 90 + 600 = 690
    assert.deepEqual(brief(a.feed(change(689, 'C-01', 'start'))), [], 'encore au repos');
    const b = machine(spec());
    b.feed(change(0, 'C-01', 'start'));
    b.feed(change(30, 'C-01', 'stop'));
    b.tick(at(90));
    assert.deepEqual(brief(b.feed(change(690, 'C-01', 'start'))), ['person_detected:C-01@690'], 'repos ecoule pile');
  });

  it("un start pendant le repos est oublie, mais un start ulterieur de la meme presence, repos ecoule, declenche", () => {
    const m = machine(spec());
    m.feed(change(0, 'C-01', 'start'));
    m.feed(change(30, 'C-01', 'stop'));
    m.tick(at(90));
    assert.deepEqual(brief(m.feed(change(300, 'C-02', 'start'))), []);
    assert.deepEqual(brief(m.tick(at(2000))), [], "pas de start, pas d'evenement : « apparait » ne declenche pas tout seul");
    assert.deepEqual(brief(m.feed(change(2100, 'C-01', 'start'))), ['person_detected:C-01@2100']);
  });

  it('repos de 0 : redeclenche des la presence suivante ; repos non cumulatif avec la presence qui se prolonge', () => {
    const m = machine(spec({ cooldownMinutes: 0 }));
    m.feed(change(0, 'C-01', 'start'));
    m.feed(change(10, 'C-01', 'stop'));
    assert.deepEqual(brief(m.feed(change(100, 'C-01', 'start'))), ['clear@70', 'person_detected:C-01@100']);
  });

  it('repos et « reste » : le declenchement attend la fin du repos si la presence dure toujours', () => {
    const m = machine(stays(1)); // repos 10 min
    m.feed(change(0, 'C-01', 'start'));
    assert.deepEqual(brief(m.tick(at(60))), ['person_lingering:C-01@60']);
    m.feed(change(100, 'C-01', 'stop'));
    assert.deepEqual(brief(m.tick(at(160))), ['clear@160']); // repos jusqu'a 160 + 600 = 760
    m.feed(change(200, 'C-01', 'start'));
    assert.equal(m.nextWake(), at(760));
    assert.deepEqual(brief(m.tick(at(759))), []);
    assert.deepEqual(brief(m.tick(at(2000))), ['person_lingering:C-01@760']);
  });
});

describe('machine de regle : « reste N minutes »', () => {
  it("se declenche a l'instant exact ou la duree est atteinte, et se termine avec la presence", () => {
    const m = machine(stays(5));
    assert.deepEqual(brief(m.feed(change(0, 'C-01', 'start'))), []);
    assert.equal(m.nextWake(), at(300));
    assert.deepEqual(brief(m.tick(at(299))), []);
    assert.deepEqual(brief(m.tick(at(1000))), ['person_lingering:C-01@300'], 'date de la duree atteinte, pas du tick');
    m.feed(change(1100, 'C-01', 'stop'));
    assert.deepEqual(brief(m.tick(at(2000))), ['clear@1160']);
  });

  it("une presence plus courte que la duree ne declenche rien, et n'envoie aucun clear", () => {
    const m = machine(stays(5));
    m.feed(change(0, 'C-01', 'start'));
    m.feed(change(100, 'C-01', 'stop'));
    assert.deepEqual(brief(m.tick(at(5000))), []);
    assert.equal(m.isTriggered(), false);
  });

  it('la duree compte depuis le debut de la presence lissee : un trou de moins de 60 s ne la remet pas a zero, un trou plus long oui', () => {
    const smooth = machine(stays(5));
    smooth.feed(change(0, 'C-01', 'start'));
    smooth.feed(change(100, 'C-01', 'stop'));
    smooth.feed(change(150, 'C-02', 'start'));
    assert.deepEqual(brief(smooth.tick(at(400))), ['person_lingering:C-01@300'].map((x) => x.replace('C-01', 'C-02')), 'camera concernee = celle qui est occupee');
    const cut = machine(stays(5));
    cut.feed(change(0, 'C-01', 'start'));
    cut.feed(change(100, 'C-01', 'stop'));
    cut.feed(change(200, 'C-01', 'start'));
    assert.deepEqual(brief(cut.tick(at(499))), []);
    assert.deepEqual(brief(cut.tick(at(600))), ['person_lingering:C-01@500']);
  });
});

describe('machine de regle : plages horaires, y compris a cheval sur minuit', () => {
  // Plage du lundi uniquement, 22:00 -> 06:00 : la nuit de lundi a mardi.
  const mondayNight = spec({ when: { type: 'windows', windows: [{ days: [1], from: '22:00', to: '06:00' }] } });
  const fires = (s: RuleSpec, day: number, h: number, m: number) => machine(s).feed(changeAt(T0 + (hms(day, h, m)) * S, 'C-01', 'start')).length > 0;

  it('« apparait » ne declenche que dans la plage, avant minuit comme apres', () => {
    assert.equal(fires(mondayNight, 0, 21, 59), false, 'lundi 21:59 : avant la plage');
    assert.equal(fires(mondayNight, 0, 22, 0), true, 'lundi 22:00 : debut inclus');
    assert.equal(fires(mondayNight, 0, 23, 30), true);
    assert.equal(fires(mondayNight, 1, 3, 0), true, 'mardi 03:00 : suite de la nuit de lundi');
    assert.equal(fires(mondayNight, 1, 5, 59), true);
    assert.equal(fires(mondayNight, 1, 6, 0), false, 'mardi 06:00 : fin exclue');
    assert.equal(fires(mondayNight, 1, 23, 0), false, 'mardi soir : pas dans la plage du lundi');
    assert.equal(fires(mondayNight, 0, 3, 0), false, 'lundi 03:00 : appartiendrait a la nuit de dimanche');
  });

  it('plage dans la journee, plusieurs plages', () => {
    const day = spec({ when: { type: 'windows', windows: [{ days: [1], from: '08:00', to: '12:00' }, { days: [1], from: '14:00', to: '18:00' }] } });
    assert.equal(fires(day, 0, 7, 59), false);
    assert.equal(fires(day, 0, 8, 0), true);
    assert.equal(fires(day, 0, 12, 0), false);
    assert.equal(fires(day, 0, 13, 0), false);
    assert.equal(fires(day, 0, 17, 59), true);
  });

  it("« reste » dont la plage s'ouvre en cours de presence : la duree compte depuis le DEBUT de la presence", () => {
    const m = machine(stays(30, { when: night() }));
    assert.deepEqual(brief(m.feed(changeAt(at(hms(0, 20)), 'C-01', 'start'))), []);
    assert.deepEqual(brief(m.tick(at(hms(0, 21, 59, 59)))), [], 'plage pas encore ouverte');
    // 20:00 + 30 min est passe depuis longtemps : le declenchement a lieu a l'ouverture de la plage, 22:00 pile
    assert.deepEqual(brief(m.tick(at(hms(0, 22, 0, 30)))), [`person_lingering:C-01@${hms(0, 22)}`]);
  });

  it("une fois declenchee, la regle reste declenchee jusqu'a la fin de la presence, meme si la plage se ferme", () => {
    const m = machine(stays(30, { when: night() }));
    m.feed(changeAt(at(hms(0, 23)), 'C-01', 'start'));
    assert.deepEqual(brief(m.tick(at(hms(0, 23, 30)))), [`person_lingering:C-01@${hms(0, 23, 30)}`]);
    assert.deepEqual(brief(m.tick(at(hms(1, 7)))), [], '07:00 : plage fermee, rien ne change');
    assert.equal(m.isTriggered(), true);
    m.feed(changeAt(at(hms(1, 7, 10)), 'C-01', 'stop'));
    assert.deepEqual(brief(m.tick(at(hms(1, 8)))), [`clear@${hms(1, 7, 11)}`]);
  });

  it("« reste » : une presence qui finit avant l'ouverture de la plage ne declenche rien", () => {
    const m = machine(stays(30, { when: night() }));
    m.feed(changeAt(at(hms(0, 20)), 'C-01', 'start'));
    m.feed(changeAt(at(hms(0, 21, 30)), 'C-01', 'stop'));
    assert.deepEqual(brief(m.tick(at(hms(1, 6)))), []);
  });

  it("« apparait » : un start hors plage est oublie, mais un mouvement ulterieur de la meme presence, dans la plage, declenche", () => {
    const m = machine(spec({ when: night() }));
    assert.deepEqual(brief(m.feed(changeAt(at(hms(0, 20)), 'C-01', 'start'))), []);
    assert.deepEqual(brief(m.feed(changeAt(at(hms(0, 22, 5)), 'C-01', 'stop'))), []);
    assert.deepEqual(brief(m.feed(changeAt(at(hms(0, 22, 5, 30)), 'C-01', 'start'))), [`person_detected:C-01@${hms(0, 22, 5, 30)}`]);
  });
});

describe('machine de regle : « quand la zone est armee », par camera', () => {
  it("« apparait » : seule la camera du start compte", () => {
    const m = machine(spec({ when: { type: 'armed' } }), { 'C-02': false });
    assert.deepEqual(brief(m.feed(change(0, 'C-02', 'start'))), [], 'zone de C-02 desarmee');
    assert.deepEqual(brief(m.feed(change(5, 'C-01', 'start'))), ['person_detected:C-01@5'], 'zone de C-01 armee');
  });

  it("« reste » : il faut qu'une camera ou quelqu'un est present soit en zone armee ; c'est elle qui est designee", () => {
    const m = machine(stays(1, { when: { type: 'armed' } }), { 'C-01': false });
    assert.deepEqual(brief(m.feed(change(0, 'C-01', 'start'))), []);
    assert.deepEqual(brief(m.tick(at(600))), [], 'jamais armee : jamais declenchee');
    assert.deepEqual(brief(m.feed(change(700, 'C-02', 'start'))), ['person_lingering:C-02@700']);
  });

  it("« reste » : la zone qui s'arme en cours de presence declenche a la minute suivante", () => {
    const armed: Record<string, boolean> = { 'C-01': false };
    const m = machine(stays(1, { when: { type: 'armed' } }), armed);
    m.feed(change(0, 'C-01', 'start'));
    assert.deepEqual(brief(m.tick(at(300))), []);
    armed['C-01'] = true;
    assert.deepEqual(brief(m.tick(at(360))), ['person_lingering:C-01@360']);
  });
});

describe('machine de regle : direct (init, arret force) et temps', () => {
  it("init avec une presence deja en cours : « apparait » ne declenche pas, « reste » declenche si la duree est deja atteinte", () => {
    const appears = machine(spec());
    assert.deepEqual(brief(appears.init({ 'C-01': { since: at(-3600) }, 'C-09': { since: at(-5) } }, at(0))), []);
    assert.equal(appears.isTriggered(), false);
    const lingering = machine(stays(30));
    assert.deepEqual(brief(lingering.init({ 'C-01': { since: at(-3600) } }, at(0))), ['person_lingering:C-01@0']);
    assert.equal(lingering.isTriggered(), true);
    const recent = machine(stays(30));
    recent.init({ 'C-01': { since: at(-600) } }, at(0));
    assert.equal(recent.nextWake(), at(1200), '30 min apres le debut de la presence');
  });

  it("release : un seul clear si elle sonnait, rien sinon, et pas de repos ensuite", () => {
    const m = machine(spec());
    assert.deepEqual(brief(m.release(at(1))), []);
    m.feed(change(0, 'C-01', 'start'));
    assert.deepEqual(brief(m.release(at(5))), ['clear@5']);
    assert.deepEqual(brief(m.release(at(6))), []);
  });

  it('nextWake : rien au repos, la fin apres un stop, la duree pour « reste », la minute suivante en attente de plage', () => {
    const m = machine(stays(5, { when: night() }));
    assert.equal(m.nextWake(), null);
    m.feed(changeAt(at(hms(0, 10)), 'C-01', 'start'));
    assert.equal(m.nextWake(), at(hms(0, 10, 5)));
    m.tick(at(hms(0, 10, 5, 20)));
    assert.equal(m.nextWake(), at(hms(0, 10, 6)), 'en attente de la plage : on regarde chaque minute');
  });

  it("deux facons d'avancer le temps (un tick par seconde, ou seulement aux evenements) donnent exactement les memes actions", () => {
    // generateur pseudo-aleatoire a graine fixe
    const prng = (seed: number) => {
      let x = seed >>> 0;
      return () => (x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 2 ** 32;
    };
    const specs: RuleSpec[] = [
      spec({ cooldownMinutes: 0 }),
      spec({ cooldownMinutes: 3 }),
      stays(2, { cooldownMinutes: 1 }),
      stays(7, { cooldownMinutes: 0, then: { severity: 'warning' } }),
      spec({ when: night(), cooldownMinutes: 5 }),
      stays(10, { when: night(), cooldownMinutes: 5 }),
      spec({ when: { type: 'armed' }, cooldownMinutes: 2 }),
      stays(3, { when: { type: 'armed' }, cooldownMinutes: 2 }),
    ];
    const start = hms(0, 20);
    const end = hms(1, 4);
    for (let seed = 1; seed <= 4; seed++) {
      const rnd = prng(seed * 7919);
      const events: { sec: number; cameraId: string; kind: 'start' | 'stop' }[] = [];
      for (const cameraId of ['C-01', 'C-02']) {
        let t = start + Math.floor(rnd() * 600);
        let kind: 'start' | 'stop' = 'start';
        while (t < end - 3600) {
          events.push({ sec: t, cameraId, kind });
          // trous : souvent courts (flot continu), parfois longs ; presences de quelques secondes a quelques minutes
          t += kind === 'start' ? 5 + Math.floor(rnd() * 400) : rnd() < 0.7 ? 5 + Math.floor(rnd() * 90) : 120 + Math.floor(rnd() * 3000);
          kind = kind === 'start' ? 'stop' : 'start';
        }
      }
      events.sort((a, b) => a.sec - b.sec);
      for (const [i, s] of specs.entries()) {
        const armed = { 'C-02': seed % 2 === 0 };
        const dense = machine(s, armed);
        const sparse = machine(s, armed);
        const denseOut: RuleAction[] = [];
        let k = 0;
        for (let sec = start; sec <= end; sec++) {
          while (k < events.length && events[k].sec <= sec) denseOut.push(...dense.feed(change(events[k++].sec, events[k - 1].cameraId, events[k - 1].kind)));
          denseOut.push(...dense.tick(at(sec)));
        }
        const sparseOut: RuleAction[] = [];
        for (const e of events) sparseOut.push(...sparse.feed(change(e.sec, e.cameraId, e.kind)));
        sparseOut.push(...sparse.tick(at(end)));
        assert.deepEqual(brief(denseOut), brief(sparseOut), `graine ${seed}, regle ${i}`);
      }
    }
  });
});

// ---- 4. Regles, detecteurs virtuels, direct ----------------------------------------------------------------------

function fakePresence() {
  const listeners = new Set<(c: PresenceChange) => void>();
  const log: PresenceChange[] = [];
  const open = new Map<string, number>();
  return {
    emit(c: PresenceChange) {
      log.push(c);
      if (c.kind === 'start') open.set(c.cameraId, c.at);
      else open.delete(c.cameraId);
      for (const fn of [...listeners]) fn(c);
    },
    /** Historique ajoute sans prevenir personne (essai sur le passe). */
    seed(changes: PresenceChange[]) {
      log.push(...changes);
    },
    subscribe(fn: (c: PresenceChange) => void) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    history(from: number, to: number, cameraIds?: string[]): PresenceChange[] {
      return log
        .filter((c) => c.at >= from && c.at <= to && (!cameraIds || cameraIds.includes(c.cameraId)))
        .map((c, i) => ({ c, i }))
        .sort((a, b) => a.c.at - b.c.at || a.i - b.i)
        .map((x) => x.c);
    },
    current(): Record<string, { since: number }> {
      return Object.fromEntries([...open].map(([cameraId, since]) => [cameraId, { since }]));
    },
    listenerCount: () => listeners.size,
  };
}

type Script = [sec: number, cameraId: string, kind: 'start' | 'stop'][];

function setup(opts: { armed?: Record<string, boolean> } = {}) {
  const db = openDb(':memory:');
  seedDemo(db, mkdtempSync(join(tmpdir(), 'psim-')), join(import.meta.dirname, '..', 'seed'));
  let clock = T0;
  let sec = 0;
  const engine = createEngine(db, () => {}, () => clock);
  const sent: { sec: number; deviceId: string; event: string }[] = [];
  const calls: string[] = [];
  const spied = {
    handleDetectorMessage: (deviceId: string, payload: unknown) => {
      const event = (payload as { event: string }).event;
      sent.push({ sec: (clock - T0) / S, deviceId, event });
      calls.push(`${deviceId}:${event}`);
      engine.handleDetectorMessage(deviceId, payload);
    },
    audit: engine.audit,
    getDevice: engine.getDevice,
    createDevice: engine.createDevice,
    updateDevice: engine.updateDevice,
    deleteDevice: (actor: string, id: string) => {
      calls.push(`delete:${id}`);
      engine.deleteDevice(actor, id);
    },
    setLinks: engine.setLinks,
    getSnapshot: engine.getSnapshot,
  };
  const presence = fakePresence();
  const armed: Record<string, boolean> = { ...opts.armed };
  const build = () => createRules({ db, engine: spied, presence, isArmed: (zone) => armed[zone] !== false, now: () => clock });
  const h = {
    db,
    engine,
    presence,
    armed,
    sent,
    calls,
    rules: build(),
    restart() {
      h.rules.close();
      h.rules = build();
      return h.rules;
    },
    emit(cameraId: string, kind: 'start' | 'stop') {
      presence.emit({ cameraId, kind, at: clock, source: 'test' });
    },
    /** Avance l'horloge seconde par seconde jusqu'a `until`, en jouant les changements du scenario et un tick par seconde. */
    play(script: Script, until: number) {
      const todo = script.map((e, i) => ({ e, i })).sort((a, b) => a.e[0] - b.e[0] || a.i - b.i).map((x) => x.e);
      let k = 0;
      const fire = (s: number) => {
        while (k < todo.length && todo[k][0] <= s) {
          h.emit(todo[k][1], todo[k][2]);
          k++;
        }
      };
      fire(sec);
      for (let s = sec + 1; s <= until; s++) {
        sec = s;
        clock = T0 + s * S;
        fire(s);
        h.rules.tick();
      }
    },
    run(until: number) {
      h.play([], until);
    },
    status: (id: string) => engine.getDevice(id)?.status,
    audit: (prefix = 'rule_') => engine.listAudit(500).filter((a) => a.action.startsWith(prefix)).reverse(),
    triggers: () => sent.filter((m) => m.event !== 'clear'),
    clears: () => sent.filter((m) => m.event === 'clear'),
  };
  return h;
}

const create = (h: ReturnType<typeof setup>, s: RuleSpec, name = 'Cour', extra: { sourceText?: string | null; enabled?: boolean } = {}) =>
  h.rules.create('admin', { name, spec: s, ...extra });

describe('regles de presence : detecteur virtuel', () => {
  it('chaque regle a son detecteur R-<id> : categorie acces, non supervise, zone/etage/position de la 1re camera, liens = la portee', () => {
    const h = setup();
    const rule = create(h, spec({ where: { cameras: ['C-04', 'C-01'] } }), 'Entrepot et accueil');
    assert.equal(rule.id, 1);
    assert.equal(rule.deviceId, 'R-1');
    const device = h.engine.getDevice('R-1')!;
    const c04 = h.engine.getDevice('C-04')!;
    assert.equal(device.kind, 'detector');
    assert.equal(device.name, 'Entrepot et accueil');
    assert.equal(device.category, 'access');
    assert.equal(device.heartbeatS, 0);
    assert.equal(device.zone, c04.zone);
    assert.equal(device.floorId, c04.floorId);
    assert.equal(device.x, c04.x);
    assert.equal(device.y, c04.y);
    assert.equal(device.status, 'normal');
    assert.deepEqual(h.engine.getSnapshot().links['R-1'], ['C-01', 'C-04']);
    assert.equal(create(h, spec()).deviceId, 'R-2');
  });

  it('une regle par zones vise les cameras de ces zones (et seulement des cameras)', () => {
    const h = setup();
    const rule = create(h, spec({ where: { zones: ['Accueil', 'Atelier'] } }), 'Deux zones');
    // D-01 est un detecteur de la zone Accueil : il n'est pas une camera
    assert.deepEqual(h.engine.getSnapshot().links[rule.deviceId], ['C-01', 'C-05']);
    assert.equal(h.engine.getDevice(rule.deviceId)!.zone, 'Accueil', 'zone de la 1re camera');
  });

  it("une zone sans camera est refusee avec un message clair, et rien n'est cree", () => {
    const h = setup();
    h.engine.createDevice('admin', { id: 'D-90', kind: 'detector', name: 'Cave', zone: 'Cave' });
    assert.throws(() => create(h, spec({ where: { zones: ['Cave'] } })), (e: unknown) => e instanceof PsimError && e.status === 400 && /La zone « Cave » n'a aucune camera/.test(e.message));
    assert.equal(h.rules.list().length, 0);
    assert.equal(h.engine.getDevice('R-1'), null);
  });

  it("le nom du detecteur suit le nom de la regle ; zone et liens suivent la portee ; x et y ne sont ecrases que si la 1re camera change", () => {
    const h = setup();
    const rule = create(h, spec());
    h.engine.updateDevice('admin', 'R-1', { x: 12, y: 34 }); // l'administrateur l'a deplace sur le plan
    h.rules.update('admin', rule.id, { name: 'Nouvelle cour' });
    assert.equal(h.engine.getDevice('R-1')!.name, 'Nouvelle cour');
    assert.equal(h.engine.getDevice('R-1')!.x, 12);

    h.rules.update('admin', rule.id, { spec: spec({ where: { cameras: ['C-01', 'C-02'] } }) });
    assert.deepEqual(h.engine.getSnapshot().links['R-1'], ['C-01', 'C-02']);
    assert.equal(h.engine.getDevice('R-1')!.x, 12, 'meme 1re camera : position conservee');
    assert.equal(h.engine.getDevice('R-1')!.y, 34);

    h.rules.update('admin', rule.id, { spec: spec({ where: { cameras: ['C-04', 'C-01'] } }) });
    const c04 = h.engine.getDevice('C-04')!;
    const moved = h.engine.getDevice('R-1')!;
    assert.deepEqual([moved.zone, moved.x, moved.y, moved.floorId], [c04.zone, c04.x, c04.y, c04.floorId], '1re camera changee : le detecteur la suit');
    assert.deepEqual(h.engine.getSnapshot().links['R-1'], ['C-01', 'C-04']);
  });
});

describe('regles de presence : direct', () => {
  it("un start ouvre un incident critique sur R-1 (motif, cameras liees), et la fin 60 s apres le dernier stop remet le detecteur a la normale", () => {
    const h = setup();
    create(h, spec({ where: { cameras: ['C-01', 'C-02'] } }));
    h.emit('C-01', 'start');
    assert.equal(h.status('R-1'), 'alarm');
    const [incident] = h.engine.getSnapshot().incidents;
    assert.equal(incident.detectorId, 'R-1');
    assert.equal(incident.severity, 'critical');
    assert.equal(incident.event, 'person_detected');
    assert.deepEqual(incident.cameraIds, ['C-01', 'C-02']);
    h.run(20);
    h.emit('C-01', 'stop');
    h.run(79);
    assert.equal(h.status('R-1'), 'alarm', 'moins de 60 s apres le stop');
    h.run(80);
    assert.equal(h.status('R-1'), 'normal');
    assert.deepEqual(h.sent.map((m) => `${m.sec}:${m.event}`), ['0:person_detected', '80:clear']);
    assert.equal(h.engine.getSnapshot().incidents[0].status, 'open', "l'incident reste a qualifier par l'operateur");
  });

  it("gravite « avertissement » : prealarme person_noticed ; « reste N min » : person_lingering", () => {
    const h = setup();
    create(h, spec({ where: { cameras: ['C-01'] }, then: { severity: 'warning' } }), 'Avertir');
    create(h, stays(2, { where: { cameras: ['C-02'] } }), 'Rester');
    h.emit('C-01', 'start');
    assert.equal(h.status('R-1'), 'prealarm');
    assert.equal(h.engine.getSnapshot().incidents[0].severity, 'warning');
    h.emit('C-02', 'start');
    h.run(119);
    assert.equal(h.status('R-2'), 'normal');
    h.run(120);
    assert.equal(h.status('R-2'), 'alarm');
    assert.deepEqual(h.triggers().map((m) => `${m.deviceId}:${m.event}`), ['R-1:person_noticed', 'R-2:person_lingering']);
  });

  it('une regle ne reagit qu\'aux cameras de sa portee', () => {
    const h = setup();
    create(h, spec({ where: { cameras: ['C-01'] } }));
    h.emit('C-03', 'start');
    assert.equal(h.sent.length, 0);
  });

  it("repos : pas de redeclenchement avant cooldownMinutes apres la fin, puis oui (direct)", () => {
    const h = setup();
    create(h, spec({ cooldownMinutes: 5 }));
    h.play([[0, 'C-01', 'start'], [10, 'C-01', 'stop']], 71); // fin a 70 -> repos jusqu'a 370
    assert.deepEqual(h.sent.map((m) => `${m.sec}:${m.event}`), ['0:person_detected', '70:clear']);
    h.play([[300, 'C-01', 'start'], [310, 'C-01', 'stop']], 369);
    assert.equal(h.triggers().length, 1, 'encore au repos');
    h.play([[400, 'C-01', 'start']], 401);
    assert.equal(h.triggers().length, 2);
  });

  it('« quand la zone est armee » : zone armee / non armee, par camera', () => {
    const h = setup({ armed: { Couloir: false } }); // C-01 -> Accueil (armee), C-02 -> Couloir (desarmee)
    create(h, spec({ where: { cameras: ['C-01', 'C-02'] }, when: { type: 'armed' }, cooldownMinutes: 0 }));
    h.emit('C-02', 'start');
    assert.equal(h.sent.length, 0, 'zone Couloir desarmee');
    h.emit('C-01', 'start');
    assert.equal(h.triggers().length, 1);
    assert.equal(h.status('R-1'), 'alarm');
  });

  it("plage de nuit a cheval sur minuit en direct : declenche a 23:30 et a 03:00, pas a 12:00", () => {
    const h = setup();
    create(h, spec({ when: night(), cooldownMinutes: 0 }));
    h.play([[hms(0, 12), 'C-01', 'start'], [hms(0, 12, 1), 'C-01', 'stop']], hms(0, 12, 5));
    assert.equal(h.triggers().length, 0);
    // pas d'attente seconde par seconde pour traverser la journee : sauts d'horloge, un tick a chaque etape
    const jump = (s: number) => h.run(s);
    jump(hms(0, 23, 29, 59));
    h.play([[hms(0, 23, 30), 'C-01', 'start'], [hms(0, 23, 31), 'C-01', 'stop']], hms(0, 23, 33));
    assert.equal(h.triggers().length, 1);
    h.play([[hms(1, 3), 'C-01', 'start'], [hms(1, 3, 1), 'C-01', 'stop']], hms(1, 3, 3));
    assert.equal(h.triggers().length, 2);
  });
});

describe('regles de presence : desactivation, suppression, journal', () => {
  it("une regle desactivee pendant une alarme envoie clear, le detecteur revient a normal, puis plus rien ; reactivee, elle reagit", () => {
    const h = setup();
    const rule = create(h, spec());
    h.emit('C-01', 'start');
    assert.equal(h.status('R-1'), 'alarm');
    h.run(5);
    h.rules.update('admin', rule.id, { enabled: false });
    assert.deepEqual(h.clears().map((m) => m.sec), [5]);
    assert.equal(h.status('R-1'), 'normal');
    assert.equal(h.rules.get(rule.id)!.enabled, false);
    const before = h.sent.length;
    h.emit('C-01', 'stop');
    h.emit('C-01', 'start');
    h.run(500);
    assert.equal(h.sent.length, before, 'plus aucun message');
    h.rules.update('admin', rule.id, { enabled: true });
    h.emit('C-01', 'stop');
    h.run(700);
    h.emit('C-01', 'start');
    assert.equal(h.status('R-1'), 'alarm');
  });

  it("une regle creee desactivee ne reagit pas mais reste simulable", () => {
    const h = setup();
    const s = spec();
    const rule = create(h, s, 'Eteinte', { enabled: false });
    h.play([[0, 'C-01', 'start'], [30, 'C-01', 'stop']], 200);
    assert.equal(h.sent.length, 0);
    assert.equal(h.status(rule.deviceId), 'normal');
    assert.equal(h.rules.simulate(s, T0, at(300)).triggers.length, 1);
  });

  it("suppression d'une regle qui a declenche des incidents : refusee (409), la regle et son detecteur restent, l'alarme n'est pas touchee", () => {
    const h = setup();
    const rule = create(h, spec());
    h.emit('C-01', 'start');
    assert.throws(
      () => h.rules.remove('admin', rule.id),
      (e: unknown) => e instanceof PsimError && e.status === 409 && e.message === 'Cette regle a deja declenche des incidents : la desactiver plutot que la supprimer',
    );
    assert.equal(h.rules.list().length, 1);
    assert.equal(h.status('R-1'), 'alarm');
    assert.equal(h.clears().length, 0);
    h.rules.update('admin', rule.id, { enabled: false }); // la voie indiquee : desactiver
    assert.equal(h.status('R-1'), 'normal');
    assert.throws(() => h.rules.remove('admin', rule.id), /deja declenche des incidents/);
    assert.ok(h.engine.getDevice('R-1'), 'le detecteur ne reste jamais orphelin : il garde sa regle');
  });

  it("une regle sans incident se supprime avec son detecteur et ses liens ; clear AVANT la suppression si le detecteur sonnait", () => {
    const h = setup();
    const rule = create(h, spec({ where: { cameras: ['C-01', 'C-02'] } }));
    h.db.prepare("UPDATE device SET status = 'alarm' WHERE id = 'R-1'").run(); // cas limite : en alarme sans incident
    h.rules.remove('admin', rule.id);
    assert.deepEqual(h.calls.slice(-2), ['R-1:clear', 'delete:R-1'], 'clear d\'abord');
    assert.equal(h.rules.list().length, 0);
    assert.equal(h.rules.get(rule.id), null);
    assert.equal(h.engine.getDevice('R-1'), null);
    assert.equal((h.db.prepare("SELECT COUNT(*) AS n FROM device_link WHERE detector_id = 'R-1'").get() as { n: number }).n, 0);
    h.emit('C-01', 'start');
    assert.equal(h.triggers().length, 0, 'plus aucune reaction');
    assert.throws(() => h.rules.remove('admin', rule.id), (e: unknown) => e instanceof PsimError && e.status === 404);
  });

  it("journal : creation (avec la phrase d'origine), modification, activation, desactivation, suppression", () => {
    const h = setup();
    const rule = create(h, spec(), 'Cour', { sourceText: 'prevenez-moi si quelqu un entre dans la cour la nuit' });
    h.rules.update('admin', rule.id, { name: 'Cour du fond' });
    h.rules.update('admin', rule.id, { enabled: false });
    h.rules.update('admin', rule.id, { enabled: true });
    const lonely = create(h, spec(), 'Sans incident');
    h.rules.remove('admin', lonely.id);
    const entries = h.audit();
    assert.deepEqual(entries.map((a) => `${a.action}:${a.deviceId}`), [
      'rule_created:R-1',
      'rule_updated:R-1',
      'rule_disabled:R-1',
      'rule_enabled:R-1',
      'rule_created:R-2',
      'rule_deleted:R-2',
    ]);
    assert.match(entries[0].details!, /prevenez-moi si quelqu un entre dans la cour la nuit/);
    assert.match(entries[0].details!, /Prévenir \(alerte critique\) si quelqu'un apparaît/);
    assert.equal(entries[0].actor, 'admin');
    assert.equal(h.rules.get(rule.id)!.sourceText, 'prevenez-moi si quelqu un entre dans la cour la nuit');
    // une mise a jour qui ne change rien n'ecrit rien
    const n = h.audit().length;
    h.rules.update('admin', rule.id, { name: 'Cour du fond', enabled: true, spec: spec() });
    assert.equal(h.audit().length, n);
  });

  it('lecture : phrase recalculee, auteur, dates, verifications de saisie', () => {
    const h = setup();
    const rule = create(h, spec({ where: { cameras: ['C-01', 'C-02'] } }), '  Cour  ');
    assert.equal(rule.name, 'Cour');
    assert.equal(rule.createdBy, 'admin');
    assert.equal(rule.createdAt, T0);
    assert.match(rule.summary, /devant les caméras « Camera accueil » ou « Camera couloir »/);
    h.engine.updateDevice('admin', 'C-01', { name: 'Porte' });
    assert.match(h.rules.get(rule.id)!.summary, /« Porte » ou « Camera couloir »/, 'la phrase suit les noms des cameras');
    const refuseCreate = (input: unknown, pattern: RegExp) =>
      assert.throws(() => h.rules.create('admin', input as never), (e: unknown) => e instanceof PsimError && e.status === 400 && pattern.test(e.message));
    refuseCreate({ name: '', spec: spec() }, /Nom de la regle requis/);
    refuseCreate({ name: '   ', spec: spec() }, /Nom de la regle requis/);
    refuseCreate({ name: 'x'.repeat(81), spec: spec() }, /max 80/);
    refuseCreate({ name: 'a\nb', spec: spec() }, /caracteres de controle/);
    refuseCreate({ name: 42, spec: spec() }, /Nom de la regle requis/);
    refuseCreate({ name: 'ok' }, /Il manque la case|objet est attendu/);
    refuseCreate({ name: 'ok', spec: spec(), role: 'admin' }, /champ « role »/);
    refuseCreate({ name: 'ok', spec: spec(), enabled: 'oui' }, /enabled/);
    refuseCreate({ name: 'ok', spec: spec(), sourceText: 'x'.repeat(1001) }, /Phrase d'origine/);
    refuseCreate({ name: 'ok', spec: spec({ where: { cameras: ['C-99'] } }) }, /camera inconnue/);
    assert.equal(h.rules.list().length, 1, 'aucune regle a moitie creee');
    assert.equal(h.engine.getDevice('R-2'), null);
    assert.throws(() => h.rules.update('admin', 99, { name: 'x' }), (e: unknown) => e instanceof PsimError && e.status === 404);
    assert.throws(() => h.rules.update('admin', rule.id, {}), /Rien a modifier/);
    assert.throws(() => h.rules.update('admin', rule.id, { spec: spec({ where: { cameras: [] } }) }), /Ou :/);
    assert.deepEqual(h.rules.get(rule.id)!.spec, rule.spec, 'une modification refusee ne change rien');
  });
});

describe('regles de presence : redemarrage', () => {
  it("les regles et leurs detecteurs survivent ; la machine repart avec les presences en cours ; l'abonnement est unique", () => {
    const h = setup();
    create(h, spec({ where: { cameras: ['C-01', 'C-02'] } }), 'Active');
    create(h, spec(), 'Eteinte', { enabled: false });
    h.rules.close();
    assert.equal(h.presence.listenerCount(), 0);
    const again = h.restart();
    assert.equal(h.presence.listenerCount(), 1);
    assert.deepEqual(again.list().map((r) => [r.id, r.name, r.enabled, r.deviceId]), [[1, 'Active', true, 'R-1'], [2, 'Eteinte', false, 'R-2']]);
    assert.ok(h.engine.getDevice('R-1') && h.engine.getDevice('R-2'));
    h.emit('C-01', 'start');
    assert.deepEqual(h.triggers().map((m) => m.deviceId), ['R-1'], 'seule la regle active reagit, une seule fois');
    // une troisieme regle ne reprend aucun numero existant
    assert.equal(again.create('admin', { name: 'Suite', spec: spec() }).deviceId, 'R-3');
  });

  it("alarme laissee par un arret brutal alors que la machine est au repos : clear envoye au demarrage", () => {
    const h = setup();
    create(h, spec());
    h.emit('C-01', 'start');
    assert.equal(h.status('R-1'), 'alarm');
    h.restart();
    assert.equal(h.status('R-1'), 'normal');
    assert.deepEqual(h.sent.map((m) => m.event), ['person_detected', 'clear']);
  });

  it("« reste » : une presence qui dure toujours apres le redemarrage garde son alarme, sans clear", () => {
    const h = setup();
    create(h, stays(2));
    h.emit('C-01', 'start');
    h.run(130);
    assert.equal(h.status('R-1'), 'alarm');
    h.restart();
    assert.equal(h.status('R-1'), 'alarm');
    assert.equal(h.clears().length, 0);
    h.emit('C-01', 'stop');
    h.run(200);
    assert.equal(h.status('R-1'), 'normal');
  });

  it("un detecteur de regle disparu est recree avec ses liens", () => {
    const h = setup();
    create(h, spec({ where: { cameras: ['C-02', 'C-01'] } }));
    h.db.prepare("DELETE FROM device_link WHERE detector_id = 'R-1'").run();
    h.db.prepare("DELETE FROM device WHERE id = 'R-1'").run();
    h.restart();
    const device = h.engine.getDevice('R-1')!;
    assert.equal(device.category, 'access');
    assert.equal(device.heartbeatS, 0);
    assert.equal(device.zone, h.engine.getDevice('C-02')!.zone);
    assert.deepEqual(h.engine.getSnapshot().links['R-1'], ['C-01', 'C-02']);
  });

  it("detecteurs R-<n> sans regle : supprimes sans historique, conserves (et signales) avec un historique ; les autres ne sont pas touches", (t) => {
    const warn = t.mock.method(console, 'warn', () => {});
    const h = setup();
    create(h, spec());
    h.engine.createDevice('admin', { id: 'R-90', kind: 'detector', name: 'Orphelin', zone: 'Accueil', category: 'access', heartbeatS: 0 });
    h.engine.createDevice('admin', { id: 'R-91', kind: 'detector', name: 'Orphelin avec historique', zone: 'Accueil', category: 'access', heartbeatS: 0 });
    h.engine.handleDetectorMessage('R-91', { event: 'person_detected' });
    h.engine.handleDetectorMessage('R-91', { event: 'clear' });
    h.engine.createDevice('admin', { id: 'R-ABC', kind: 'detector', name: 'Autre', zone: 'Accueil' });
    h.engine.createDevice('admin', { id: 'R-92', kind: 'detector', name: 'Incendie', zone: 'Accueil' }); // categorie incendie : pas un detecteur de regle
    h.restart();
    assert.equal(h.engine.getDevice('R-90'), null);
    assert.ok(h.engine.getDevice('R-91'), "conserve pour son historique d'incidents");
    assert.ok(h.engine.getDevice('R-ABC') && h.engine.getDevice('R-92') && h.engine.getDevice('R-1'));
    assert.ok(warn.mock.calls.some((c) => String(c.arguments[0]).includes('R-91')), 'signale dans le journal technique');
    // le numero de l'orphelin conserve n'est jamais reattribue
    assert.equal(h.rules.create('admin', { name: 'Nouvelle', spec: spec() }).deviceId, 'R-93');
  });
});

// ---- 5. Essai sur le passe ---------------------------------------------------------------------------------------

describe('regles de presence : essai sur le passe', () => {
  /** Joue `script` en direct, puis relit le meme passe avec simulate : les declenchements doivent etre identiques. */
  function same(s: RuleSpec, script: Script, until: number, armed: Record<string, boolean> = {}) {
    const h = setup({ armed });
    create(h, s);
    h.play(script, until);
    const sim = h.rules.simulate(s, T0, at(until));
    const liveTriggers = h.triggers().map((m) => m.sec);
    const liveClears = h.clears().map((m) => m.sec);
    assert.deepEqual(sim.triggers.map((t) => (t.at - T0) / S), liveTriggers, 'instants de declenchement');
    assert.deepEqual(sim.triggers.map((t) => (t.endedAt === null ? null : (t.endedAt - T0) / S)).filter((x) => x !== null), liveClears, 'instants de fin');
    return { h, sim, liveTriggers, liveClears };
  }

  it("« apparait » : memes declenchements, memes fins, meme camera, avec lissage et repos", () => {
    const script: Script = [
      [0, 'C-01', 'start'], [20, 'C-01', 'stop'], [70, 'C-02', 'start'], [90, 'C-02', 'stop'], // presence continue (relais, trou < 60 s)
      [200, 'C-01', 'start'], [210, 'C-01', 'stop'], // pendant le repos de 3 min : rien
      [400, 'C-02', 'start'], [405, 'C-02', 'stop'], // repos ecoule : declenche
      [500, 'C-01', 'start'], [501, 'C-01', 'stop'], // encore au repos (jusqu'a 645)
      [700, 'C-01', 'start'], [701, 'C-01', 'stop'],
    ];
    const { sim, liveTriggers } = same(spec({ where: { cameras: ['C-01', 'C-02'] }, cooldownMinutes: 3 }), script, 1200);
    assert.deepEqual(liveTriggers, [0, 400, 700]);
    assert.deepEqual(sim.triggers.map((t) => t.cameraId), ['C-01', 'C-02', 'C-01']);
    assert.deepEqual(sim.triggers.map((t) => (t.endedAt! - T0) / S), [150, 465, 761]);
  });

  it("« reste N minutes » (avec warning) : memes declenchements, la camera designee est celle qui est occupee", () => {
    const script: Script = [
      [0, 'C-01', 'start'], [100, 'C-01', 'stop'], [130, 'C-02', 'start'], [700, 'C-02', 'stop'], // 11 min 40 : declenche a 300
      [1000, 'C-01', 'start'], [1100, 'C-01', 'stop'], // 100 s : rien
    ];
    const { sim, liveTriggers } = same(stays(5, { where: { cameras: ['C-01', 'C-02'] }, then: { severity: 'warning' }, cooldownMinutes: 1 }), script, 2000);
    assert.deepEqual(liveTriggers, [300]);
    assert.equal(sim.triggers[0].cameraId, 'C-02');
    assert.equal(sim.triggers[0].endedAt, at(760));
  });

  it('plage de nuit sur deux jours : memes declenchements (traversee de minuit, repos, hors plage)', () => {
    const script: Script = [
      [hms(0, 21, 30), 'C-01', 'start'], [hms(0, 21, 40), 'C-01', 'stop'], // avant la plage
      [hms(0, 23, 10), 'C-01', 'start'], [hms(0, 23, 12), 'C-01', 'stop'], // declenche
      [hms(0, 23, 20), 'C-01', 'start'], [hms(0, 23, 21), 'C-01', 'stop'], // repos (10 min apres 23:13)
      [hms(1, 2), 'C-01', 'start'], [hms(1, 2, 1), 'C-01', 'stop'], // declenche (suite de la nuit)
      [hms(1, 6, 30), 'C-01', 'start'], [hms(1, 6, 31), 'C-01', 'stop'], // apres la plage
      [hms(1, 23, 30), 'C-01', 'start'], [hms(1, 23, 31), 'C-01', 'stop'], // declenche (nuit de mardi)
      [hms(2, 1), 'C-01', 'start'], [hms(2, 1, 2), 'C-01', 'stop'],
    ];
    const { liveTriggers } = same(spec({ when: night([1, 2]) }), script, hms(2, 2));
    assert.deepEqual(liveTriggers, [hms(0, 23, 10), hms(1, 2), hms(1, 23, 30), hms(2, 1)]);
  });

  it("« reste » dans une plage qui s'ouvre en cours de presence : memes declenchements", () => {
    const script: Script = [
      [hms(0, 20), 'C-01', 'start'], [hms(0, 23), 'C-01', 'stop'], // declenche a 22:00 (present depuis 20:00)
      [hms(0, 23, 30), 'C-01', 'start'], [hms(1, 0, 10), 'C-01', 'stop'], // declenche a 00:00 (apres le repos)
      [hms(1, 5, 50), 'C-01', 'start'], [hms(1, 6, 40), 'C-01', 'stop'], // la plage se ferme a 06:00 avant les 30 min
    ];
    const { liveTriggers } = same(stays(30, { when: night(), cooldownMinutes: 5 }), script, hms(1, 8));
    assert.deepEqual(liveTriggers, [hms(0, 22), hms(1, 0)]);
  });

  it("« zone armee » : memes declenchements (l'etat d'armement actuel sert aussi au passe)", () => {
    const script: Script = [
      [0, 'C-02', 'start'], [30, 'C-02', 'stop'], // Couloir desarme
      [300, 'C-01', 'start'], [330, 'C-01', 'stop'], // Accueil arme : declenche
      [900, 'C-02', 'start'], [905, 'C-02', 'stop'],
    ];
    const { liveTriggers, sim } = same(spec({ where: { zones: ['Accueil', 'Couloir'] }, when: { type: 'armed' }, cooldownMinutes: 1 }), script, 1500, { Couloir: false });
    assert.deepEqual(liveTriggers, [300]);
    assert.equal(sim.triggers[0].cameraId, 'C-01');
  });

  it('la phrase de resultat decrit la regle essayee', () => {
    const h = setup();
    const sim = h.rules.simulate(spec({ where: { cameras: ['C-01'] } }), T0, at(60));
    assert.equal(sim.summary, "Prévenir (alerte critique) si quelqu'un apparaît devant la caméra « Camera accueil », à toute heure ; ensuite, attendre 10 min avant de signaler à nouveau.");
    assert.deepEqual(sim.triggers, []);
  });

  it("n'a AUCUN effet de bord : ni message au moteur, ni ecriture, ni journal, ni detecteur", () => {
    const h = setup();
    h.presence.seed([
      { cameraId: 'C-01', kind: 'start', at: at(10), source: 'test' },
      { cameraId: 'C-01', kind: 'stop', at: at(40), source: 'test' },
    ]);
    const count = (table: string) => (h.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    const before = { audit: count('audit_log'), device: count('device'), rule: count('presence_rule'), incident: count('incident'), link: count('device_link'), calls: h.calls.length };
    const sim = h.rules.simulate(spec({ where: { zones: ['Accueil'] } }), T0, at(600));
    assert.equal(sim.triggers.length, 1);
    assert.deepEqual(
      { audit: count('audit_log'), device: count('device'), rule: count('presence_rule'), incident: count('incident'), link: count('device_link'), calls: h.calls.length },
      before,
    );
  });

  it("dit quand une presence n'est pas terminee (endedAt nul) et ne garde que les declenchements de la periode", () => {
    const h = setup();
    h.presence.seed([
      { cameraId: 'C-01', kind: 'start', at: at(10), source: 'test' }, // jamais arretee
      { cameraId: 'C-02', kind: 'start', at: at(5000), source: 'test' }, // hors periode
    ]);
    const s = spec({ where: { cameras: ['C-01', 'C-02'] }, cooldownMinutes: 0 });
    const sim = h.rules.simulate(s, T0, at(100));
    assert.deepEqual(sim.triggers, [{ at: at(10), endedAt: null, cameraId: 'C-01' }]);
    // la fin d'une presence qui debute dans la periode est retrouvee au-dela de la fin demandee
    h.presence.seed([{ cameraId: 'C-01', kind: 'stop', at: at(160), source: 'test' }]);
    assert.deepEqual(h.rules.simulate(s, T0, at(100)).triggers, [{ at: at(10), endedAt: at(220), cameraId: 'C-01' }]);
  });

  it('refuse une specification invalide ou une periode absurde (400), comme une saisie manuelle', () => {
    const h = setup();
    const refuse = (fn: () => unknown, pattern: RegExp) => assert.throws(fn, (e: unknown) => e instanceof PsimError && e.status === 400 && pattern.test(e.message));
    refuse(() => h.rules.simulate(spec({ where: { cameras: ['C-99'] } }), T0, at(60)), /camera inconnue/);
    refuse(() => h.rules.simulate({ ...spec(), extra: 1 }, T0, at(60)), /non reconnu/);
    refuse(() => h.rules.simulate(spec(), at(60), T0), /Periode invalide/);
    refuse(() => h.rules.simulate(spec(), NaN, T0), /Periode invalide/);
    refuse(() => h.rules.simulate(spec(), T0, T0 + 40 * 86_400_000), /trop longue/);
  });

  it('7 jours se simulent en moins d\'une seconde, pour chaque forme de regle', () => {
    const h = setup();
    const log = [];
    for (let t = 300; t < 7 * 86400; t += 600) {
      log.push({ cameraId: 'C-01', kind: 'start' as const, at: at(t), source: 'test' });
      log.push({ cameraId: 'C-01', kind: 'stop' as const, at: at(t + 180), source: 'test' });
      log.push({ cameraId: 'C-02', kind: 'start' as const, at: at(t + 200), source: 'test' }); // relais : presence continue 24 h sur 24
      log.push({ cameraId: 'C-02', kind: 'stop' as const, at: at(t + 520), source: 'test' });
    }
    h.presence.seed(log);
    const shapes: [string, RuleSpec][] = [
      ['apparait', spec({ where: { cameras: ['C-01', 'C-02'] } })],
      ['reste', stays(30, { where: { cameras: ['C-01', 'C-02'] } })],
      ['reste en plage', stays(30, { where: { cameras: ['C-01', 'C-02'] }, when: night() })],
      ['reste en zone armee jamais armee', stays(30, { where: { cameras: ['C-01', 'C-02'] }, when: { type: 'armed' } })],
    ];
    h.armed['Accueil'] = false;
    h.armed['Couloir'] = false;
    for (const [label, s] of shapes) {
      const started = performance.now();
      const sim = h.rules.simulate(s, T0, at(7 * 86400));
      const ms = performance.now() - started;
      assert.ok(ms < 1000, `${label} : ${Math.round(ms)} ms`);
      assert.ok(Array.isArray(sim.triggers));
    }
  });
});

// ---- 6. Regles d'identite (visages) ------------------------------------------------------------------------------

const UNKNOWN: Who = { type: 'unknown' };
const FAMILLE: Who = { type: 'list', cameraId: 'C-01', listId: '2', listName: 'Famille' };
const AWA: Who = { type: 'person', cameraId: 'C-01', personId: 'p-7', personName: 'Awa Koné' };
const idSpec = (who: Who, over: Partial<RuleSpec> = {}): RuleSpec => spec({ who, ...over });

describe("regles d'identite : validation", () => {
  const refuse = (input: unknown, pattern: RegExp) =>
    assert.throws(
      () => validateSpec(input, KNOWN),
      (e: unknown) => e instanceof PsimError && e.status === 400 && pattern.test(e.message),
      `devait etre refusee : ${JSON.stringify(input)}`,
    );

  it('accepte inconnu, liste et personne, et les normalise (espaces)', () => {
    assert.deepEqual(validateSpec(idSpec(UNKNOWN), KNOWN).who, { type: 'unknown' });
    assert.deepEqual(validateSpec(idSpec(FAMILLE), KNOWN).who, FAMILLE);
    assert.deepEqual(validateSpec(idSpec(AWA), KNOWN).who, AWA);
    assert.deepEqual(validateSpec(idSpec({ type: 'person', cameraId: 'C-01', personId: ' p  7 ', personName: '  Awa   Koné ' }), KNOWN).who, { type: 'person', cameraId: 'C-01', personId: 'p 7', personName: 'Awa Koné' });
    assert.deepEqual(validateSpec(idSpec(FAMILLE, { cooldownMinutes: 0, then: { severity: 'warning' } }), KNOWN).then, { severity: 'warning' });
    // bornes : 64 pour l'identifiant, 80 pour le nom
    const edge = validateSpec(idSpec({ type: 'list', cameraId: 'C-01', listId: 'x'.repeat(64), listName: 'y'.repeat(80) }), KNOWN).who as { listId: string; listName: string };
    assert.deepEqual([edge.listId.length, edge.listName.length], [64, 80]);
  });

  it('refuse les champs manquants, vides, trop longs, de mauvais type ou en trop', () => {
    refuse(idSpec({ type: 'list', cameraId: 'C-01', listName: 'F' } as never), /identifiant de la liste : texte requis/);
    refuse(idSpec({ type: 'list', cameraId: 'C-01', listId: '2' } as never), /nom de la liste : texte requis/);
    refuse(idSpec({ type: 'list', cameraId: 'C-01', listId: '', listName: 'F' }), /identifiant de la liste/);
    refuse(idSpec({ type: 'list', cameraId: 'C-01', listId: '   ', listName: 'F' }), /identifiant de la liste/);
    refuse(idSpec({ type: 'list', cameraId: 'C-01', listId: 2 as never, listName: 'F' }), /identifiant de la liste/);
    refuse(idSpec({ type: 'list', cameraId: 'C-01', listId: 'x'.repeat(65), listName: 'F' }), /64 caracteres au plus/);
    refuse(idSpec({ type: 'list', cameraId: 'C-01', listId: '2', listName: 'y'.repeat(81) }), /80 caracteres au plus/);
    refuse(idSpec({ type: 'person', cameraId: 'C-01', personId: 'p', personName: null as never }), /nom de la personne : texte requis/);
    refuse(idSpec({ type: 'person', cameraId: 'C-01', personId: 'p' } as never), /nom de la personne/);
    refuse(idSpec({ type: 'person', cameraId: 'C-01', personId: 'p', personName: 'A', listId: '2' } as never), /champ « listId »/);
    refuse(idSpec({ type: 'list', cameraId: 'C-01', listId: '2', listName: 'F', personId: 'p' } as never), /champ « personId »/);
    refuse(idSpec({ type: 'unknown', listId: '2' } as never), /champ « listId »/);
    refuse(idSpec('inconnu' as never), /objet est attendu/);
    refuse(idSpec(Object.create({ type: 'unknown' }) as never), /objet est attendu/);
  });

  it("refuse les noms hostiles (controles, invisibles, sens d'ecriture) et ne fait pas confiance aux prototypes", () => {
    for (const bad of ['a\nb', 'a\u0000b', 'a‮b', 'a​b', 'a b', 'a\u0085b']) {
      refuse(idSpec({ type: 'list', cameraId: 'C-01', listId: '2', listName: bad }), /caracteres de controle ou invisibles/);
      refuse(idSpec({ type: 'person', cameraId: 'C-01', personId: bad, personName: 'A' }), /caracteres de controle ou invisibles/);
    }
    const hostile = JSON.parse('{"type":"list","listId":"2","listName":"F","__proto__":{"x":1}}');
    refuse(idSpec(hostile), /champ « __proto__ »/);
    refuse(idSpec({ type: '__proto__' } as never), /Qui : choisir/);
    refuse(idSpec({ type: 'constructor' } as never), /Qui : choisir/);
    // un nom de champ hostile reste lisible et inoffensif dans le message d'erreur
    refuse(idSpec({ type: 'unknown', ['x\u0007y']: 1 } as never), /champ « x\?y »/);
  });

  it("un visage ne « reste » pas : « stays » est refuse pour les trois identites, accepte pour n'importe qui", () => {
    for (const who of [UNKNOWN, FAMILLE, AWA]) {
      refuse(stays(5, { who }), /pour reconnaitre un visage, seul « apparait » est possible/);
    }
    assert.equal(validateSpec(stays(5), KNOWN).trigger.type, 'stays');
  });

  it('la camera source est OBLIGATOIRE pour une liste et une personne, et doit etre connue du PSIM', () => {
    refuse(idSpec({ type: 'list', listId: '2', listName: 'F' } as never), /Qui : la camera de la liste est requise/);
    refuse(idSpec({ type: 'person', personId: 'p', personName: 'A' } as never), /Qui : la camera de la personne est requise/);
    for (const cameraId of ['', '   ', null, 7, ['C-01'], {}, true]) {
      refuse(idSpec({ type: 'list', cameraId, listId: '2', listName: 'F' } as never), /la camera de la liste est requise/);
      refuse(idSpec({ type: 'person', cameraId, personId: 'p', personName: 'A' } as never), /la camera de la personne est requise/);
    }
    refuse(idSpec({ type: 'list', cameraId: 'C-99', listId: '2', listName: 'F' }), /Qui : camera inconnue « C-99 »/);
    refuse(idSpec({ type: 'person', cameraId: 'C-99', personId: 'p', personName: 'A' }), /Qui : camera inconnue « C-99 »/);
    refuse(idSpec({ type: 'list', cameraId: ' C-01', listId: '2', listName: 'F' }), /camera inconnue/);
    refuse(idSpec({ type: 'list', cameraId: '__proto__', listId: '2', listName: 'F' }), /camera inconnue/);
    refuse(idSpec({ type: 'list', cameraId: 'C-0\u0007x', listId: '2', listName: 'F' }), /camera inconnue « C-0\?x »/);
    // les cameras de la portee ne comptent pas : seule la camera du « Qui » est verifiee ici
    assert.equal((validateSpec(idSpec({ ...FAMILLE, cameraId: 'C-03' } as Who, { where: { cameras: ['C-01'] } }), KNOWN).who as { cameraId: string }).cameraId, 'C-03');
    // « inconnu » et « n'importe qui » n'ont pas de camera et n'en acceptent pas
    refuse(idSpec({ type: 'unknown', cameraId: 'C-01' } as never), /Qui : champ « cameraId » non reconnu/);
    refuse(spec({ who: { type: 'anyone', cameraId: 'C-01' } as never }), /Qui : champ « cameraId » non reconnu/);
  });

  it("ne verifie rien aupres de l'enregistreur : une liste inconnue de tous est acceptee", () => {
    assert.doesNotThrow(() => validateSpec(idSpec({ type: 'list', cameraId: 'C-01', listId: 'base-supprimee', listName: 'Ancienne liste' }), KNOWN));
  });
});

describe("regles d'identite : phrase en francais", () => {
  const names: Record<string, string> = { 'C-01': 'Avant cour', 'C-02': 'Escalier', 'C-03': 'Portail' };
  const ctx = { cameraName: (id: string) => names[id] ?? id };

  it('visage inconnu', () => {
    assert.equal(
      describeRule(idSpec(UNKNOWN), ctx),
      'Prévenir (alerte critique) si un visage inconnu est vu devant la caméra « Avant cour », à toute heure ; ensuite, attendre 10 min avant de signaler à nouveau.',
    );
  });

  it('liste, en zone, avec plage de nuit et avertissement', () => {
    const s = idSpec({ ...FAMILLE, cameraId: 'C-03' }, { where: { zones: ['Cour'] }, when: night(), then: { severity: 'warning' } });
    assert.equal(
      describeRule(s, ctx),
      'Prévenir (avertissement) si une personne de la liste « Famille » (caméra « Portail ») est reconnue dans la zone « Cour », uniquement de 22:00 à 06:00 le lendemain, tous les jours ; ensuite, attendre 10 min avant de signaler à nouveau.',
    );
  });

  it('personne, plusieurs cameras, zone armee, repos nul', () => {
    assert.equal(
      describeRule(idSpec(AWA, { where: { cameras: ['C-01', 'C-02'] }, when: { type: 'armed' }, cooldownMinutes: 0 }), ctx),
      'Prévenir (alerte critique) si la personne « Awa Koné » (caméra « Avant cour ») est reconnue devant les caméras « Avant cour » ou « Escalier », uniquement quand la zone est armée ; ensuite, signaler à nouveau sans attendre.',
    );
  });

  it("« n'importe qui » ne change pas", () => {
    assert.match(describeRule(spec(), ctx), /^Prévenir \(alerte critique\) si quelqu'un apparaît devant la caméra « Avant cour »,/);
  });

  it("une regle ancienne sans camera source : « (caméra non précisée) », sans planter ; camera disparue : repli sur l'identifiant", () => {
    const { cameraId: _list, ...oldList } = FAMILLE as Extract<Who, { type: 'list' }>;
    const { cameraId: _person, ...oldPerson } = AWA as Extract<Who, { type: 'person' }>;
    assert.match(describeRule(idSpec(oldList as never), ctx), /^Prévenir \(alerte critique\) si une personne de la liste « Famille » \(caméra non précisée\) est reconnue devant/);
    assert.match(describeRule(idSpec(oldPerson as never), ctx), /si la personne « Awa Koné » \(caméra non précisée\) est reconnue/);
    for (const bad of [null, 7, '', {}]) {
      assert.match(describeRule(idSpec({ ...oldList, cameraId: bad } as never), ctx), /\(caméra non précisée\)/);
    }
    assert.match(describeRule(idSpec({ ...FAMILLE, cameraId: 'C-77' } as never), ctx), /« Famille » \(caméra « C-77 »\) est reconnue/);
    // le visage inconnu et « n'importe qui » ne parlent d'aucune camera source
    assert.doesNotMatch(describeRule(idSpec(UNKNOWN), ctx), /caméra non précisée/);
  });
});

describe("regles d'identite : correspondance", () => {
  it("faceMatches : inconnu, liste (groupe), personne ; « n'importe qui » ne correspond a aucun visage", () => {
    const known = { cameraId: 'C-01', kind: 'recognized' as const, personId: 'p-7', groupId: '2' };
    const unknown = { cameraId: 'C-01', kind: 'unknown' as const };
    const matches = (who: Who, obs: Parameters<typeof faceMatches>[1]) => faceMatches(who, obs, hostOf);
    assert.equal(matches(UNKNOWN, unknown), true);
    assert.equal(matches(UNKNOWN, known), false);
    assert.equal(matches(FAMILLE, known), true);
    assert.equal(matches(FAMILLE, { ...known, groupId: '3' }), false);
    assert.equal(matches(FAMILLE, { ...known, groupId: null }), false);
    assert.equal(matches(FAMILLE, unknown), false);
    assert.equal(matches(FAMILLE, { ...unknown, groupId: '2' }), false, "un inconnu n'a pas de liste");
    assert.equal(matches(AWA, known), true);
    assert.equal(matches(AWA, { ...known, personId: 'p-8' }), false);
    assert.equal(matches(AWA, { ...known, personId: null }), false);
    assert.equal(matches(AWA, unknown), false);
    assert.equal(matches({ type: 'anyone' }, known), false);
    assert.equal(matches({ type: 'anyone' }, unknown), false);
  });

  it('un enregistreur a plusieurs voies a UNE base : deux cameras du meme hote partagent liste et personne', () => {
    // FAMILLE est lue par C-01 ; l'observation vient de la voie C-02, meme enregistreur
    const onSecondChannel = { cameraId: 'C-02', kind: 'recognized' as const, personId: 'p-7', groupId: '2' };
    assert.equal(faceMatches(FAMILLE, onSecondChannel, hostOf), true);
    assert.equal(faceMatches(AWA, onSecondChannel, hostOf), true);
    assert.equal(faceMatches({ ...FAMILLE, cameraId: 'C-02' } as Who, { ...onSecondChannel, cameraId: 'C-01' }, hostOf), true, 'dans les deux sens');
  });

  it('deux appareils qui ont tous deux la liste « 1 » (et la personne « 1 ») ne se confondent pas', () => {
    const listOne: Who = { type: 'list', cameraId: 'C-01', listId: '1', listName: 'Famille' };
    const personOne: Who = { type: 'person', cameraId: 'C-01', personId: '1', personName: 'Awa' };
    const seenBy = (cameraId: string) => ({ cameraId, kind: 'recognized' as const, personId: '1', groupId: '1' });
    assert.equal(faceMatches(listOne, seenBy('C-01'), hostOf), true);
    assert.equal(faceMatches(listOne, seenBy('C-03'), hostOf), false, "la liste « 1 » de l'autre appareil n'est pas la meme");
    assert.equal(faceMatches(listOne, seenBy('C-04'), hostOf), false);
    assert.equal(faceMatches(personOne, seenBy('C-01'), hostOf), true);
    assert.equal(faceMatches(personOne, seenBy('C-03'), hostOf), false, "la personne « 1 » de l'autre appareil n'est pas la meme");
    // et dans l'autre sens : la regle lue sur la 2e camera ne reagit pas a la 1re
    assert.equal(faceMatches({ ...listOne, cameraId: 'C-03' } as Who, seenBy('C-01'), hostOf), false);
    assert.equal(faceMatches({ ...listOne, cameraId: 'C-03' } as Who, seenBy('C-03'), hostOf), true);
  });

  it('hote inconnu (camera supprimee, sans source), regle ancienne sans camera, valeurs hostiles : AUCUNE correspondance', () => {
    const known = { cameraId: 'C-01', kind: 'recognized' as const, personId: 'p-7', groupId: '2' };
    // observation d'une camera sans source ou supprimee
    assert.equal(faceMatches(FAMILLE, { ...known, cameraId: 'C-05' }, hostOf), false);
    assert.equal(faceMatches(FAMILLE, { ...known, cameraId: 'C-99' }, hostOf), false);
    assert.equal(faceMatches(FAMILLE, { ...known, cameraId: '' }, hostOf), false);
    // camera du « Qui » supprimee ou sans source : meme si l'observation a un hote, pas de « tous appareils »
    assert.equal(faceMatches({ ...FAMILLE, cameraId: 'C-99' } as Who, known, hostOf), false);
    assert.equal(faceMatches({ ...AWA, cameraId: 'C-05' } as Who, known, hostOf), false);
    // deux cameras sans source ne sont pas « le meme appareil »
    assert.equal(faceMatches({ ...FAMILLE, cameraId: 'C-05' } as Who, { ...known, cameraId: 'C-05' }, hostOf), false);
    assert.equal(faceMatches({ ...FAMILLE, cameraId: 'C-99' } as Who, { ...known, cameraId: 'C-98' }, () => null), false);
    // regle ancienne : pas de cameraId, ou une valeur qui n'est pas du texte
    const { cameraId: _gone, ...oldFamille } = FAMILLE as Extract<Who, { type: 'list' }>;
    assert.equal(faceMatches(oldFamille as never, known, hostOf), false);
    assert.equal(faceMatches({ ...oldFamille, cameraId: null } as never, known, hostOf), false);
    assert.equal(faceMatches({ ...oldFamille, cameraId: 42 } as never, known, hostOf), false);
    assert.equal(faceMatches({ ...oldFamille, cameraId: '' } as never, { ...known, cameraId: '' }, hostOf), false);
    // le visage inconnu reste « tout visage inconnu de la portee », quel que soit l'appareil
    assert.equal(faceMatches(UNKNOWN, { cameraId: 'C-99', kind: 'unknown' }, () => null), true);
  });

  it("hostOf : casse et espaces ignores ; un hote vide n'est pas un hote ; hostOf est interroge a chaque comparaison", () => {
    const known = { cameraId: 'C-02', kind: 'recognized' as const, personId: 'p-7', groupId: '2' };
    const hosts: Record<string, string | null> = { 'C-01': '  NVR.Maison.LOCAL ', 'C-02': 'nvr.maison.local' };
    assert.equal(faceMatches(FAMILLE, known, (id) => hosts[id] ?? null), true);
    hosts['C-02'] = 'nvr.maison.local:80'; // un autre texte n'est pas le meme appareil
    assert.equal(faceMatches(FAMILLE, known, (id) => hosts[id] ?? null), false);
    hosts['C-01'] = '   ';
    hosts['C-02'] = '   ';
    assert.equal(faceMatches(FAMILLE, known, (id) => hosts[id] ?? null), false, 'deux hotes vides ne se correspondent pas');
    let calls = 0;
    const counting = (id: string) => (calls++, hostOf(id));
    faceMatches(FAMILLE, { ...known, cameraId: 'C-01' }, counting);
    faceMatches(FAMILLE, { ...known, cameraId: 'C-01' }, counting);
    assert.equal(calls, 4, 'aucune mise en cache dans faceMatches');
  });

  it('garde de nom : un nom different ne correspond pas (casse, espaces et normalisation ignores) ; sans nom, la correspondance par (appareil, identifiant) reste', () => {
    const base = { cameraId: 'C-01', kind: 'recognized' as const, personId: 'p-7', groupId: '2' };
    const list = (groupName: unknown) => faceMatches(FAMILLE, { ...base, groupName } as never, hostOf);
    const person = (personName: unknown) => faceMatches(AWA, { ...base, personName } as never, hostOf);
    // egal a la casse, aux espaces et a la forme Unicode pres
    for (const name of ['Famille', 'famille', 'FAMILLE', '  Famille ', 'Famille  ']) assert.equal(list(name), true, JSON.stringify(name));
    assert.equal(list('Famille  '), true);
    assert.equal(person('Awa Koné'), true);
    assert.equal(person('  awa   koné '), true);
    assert.equal(person('AWA KONÉ'), true);
    assert.equal(person('Awa Koné'), true, 'e + accent combinant == e accent (NFC)');
    // nom different : pas de correspondance, meme avec le bon appareil et le bon numero
    for (const name of ['Visiteurs', 'Familles', 'Fam ille', 'Famille 2', 'x']) assert.equal(list(name), false, name);
    assert.equal(person('Bob'), false);
    assert.equal(person('Awa Kone'), false, "un accent change le nom");
    // sans nom (absent, null, vide, espaces, pas du texte) : on garde la correspondance par (hote, identifiant)
    for (const name of [undefined, null, '', '   ', 12]) {
      assert.equal(list(name), true, String(name));
      assert.equal(person(name), true, String(name));
    }
    // le nom de personne ne protege pas la liste, ni l'inverse
    assert.equal(faceMatches(FAMILLE, { ...base, personName: 'Bob' }, hostOf), true);
    assert.equal(faceMatches(AWA, { ...base, groupName: 'Visiteurs' }, hostOf), true);
    // la garde ne remplace pas les autres conditions
    assert.equal(faceMatches(FAMILLE, { ...base, groupName: 'Famille', groupId: '3' }, hostOf), false);
    assert.equal(faceMatches(FAMILLE, { ...base, groupName: 'Famille', cameraId: 'C-03' }, hostOf), false);
    assert.equal(faceMatches(UNKNOWN, { cameraId: 'C-01', kind: 'unknown', groupName: 'Visiteurs' }, hostOf), true, "« inconnu » n'a pas de nom a verifier");
  });

  it('faceMismatch : meme appareil, meme identifiant, nom different (et seulement cela)', () => {
    const base = { cameraId: 'C-02', kind: 'recognized' as const, personId: 'p-7', groupId: '2' };
    assert.equal(faceMismatch(FAMILLE, { ...base, groupName: 'Visiteurs' }, hostOf), true);
    assert.equal(faceMismatch(AWA, { ...base, personName: 'Bob' }, hostOf), true);
    assert.equal(faceMismatch(FAMILLE, { ...base, groupName: ' famille ' }, hostOf), false, 'meme nom');
    assert.equal(faceMismatch(FAMILLE, base, hostOf), false, 'sans nom');
    assert.equal(faceMismatch(FAMILLE, { ...base, groupName: 'Visiteurs', groupId: '3' }, hostOf), false, 'autre numero : une autre liste, pas la meme renommee');
    assert.equal(faceMismatch(FAMILLE, { ...base, groupName: 'Visiteurs', cameraId: 'C-03' }, hostOf), false, 'autre appareil');
    assert.equal(faceMismatch(FAMILLE, { ...base, groupName: 'Visiteurs', cameraId: 'C-05' }, hostOf), false, 'camera sans source');
    assert.equal(faceMismatch(FAMILLE, { cameraId: 'C-02', kind: 'unknown', groupName: 'Visiteurs' }, hostOf), false);
    assert.equal(faceMismatch(UNKNOWN, { ...base, groupName: 'Visiteurs' }, hostOf), false);
    assert.equal(faceMismatch({ type: 'anyone' }, { ...base, groupName: 'Visiteurs' }, hostOf), false);
    const { cameraId: _gone, ...old } = FAMILLE as Extract<Who, { type: 'list' }>;
    assert.equal(faceMismatch(old as never, { ...base, groupName: 'Visiteurs' }, hostOf), false, 'regle ancienne');
  });

  it('whoNeedsReview : liste / personne sans camera, ou dont la camera est supprimee ou sans source', () => {
    const { cameraId: _gone, ...oldFamille } = FAMILLE as Extract<Who, { type: 'list' }>;
    assert.equal(whoNeedsReview(FAMILLE, hostOf), false);
    assert.equal(whoNeedsReview(AWA, hostOf), false);
    assert.equal(whoNeedsReview(oldFamille as never, hostOf), true);
    assert.equal(whoNeedsReview({ ...AWA, cameraId: null } as never, hostOf), true);
    assert.equal(whoNeedsReview({ ...AWA, cameraId: '' }, hostOf), true);
    assert.equal(whoNeedsReview({ ...AWA, cameraId: 'C-99' }, hostOf), true, 'camera supprimee');
    assert.equal(whoNeedsReview({ ...FAMILLE, cameraId: 'C-05' } as Who, hostOf), true, 'camera sans source');
    assert.equal(whoNeedsReview(UNKNOWN, () => null), false);
    assert.equal(whoNeedsReview({ type: 'anyone' }, () => null), false);
  });
});

function idMachine(s: RuleSpec, armed: Record<string, boolean> = {}, hosts: (cameraId: string) => string | null = hostOf) {
  return createRuleMachine(s, { cameras: ['C-01', 'C-02', 'C-03', 'C-04'], isArmed: (cameraId) => armed[cameraId] !== false, hostOf: hosts });
}
const seen = (sec: number, cameraId: string, kind: 'recognized' | 'unknown' = 'unknown', personId: string | null = null, groupId: string | null = null) => ({ cameraId, at: at(sec), kind, personId, groupId });
const seenAt = (ms: number, cameraId: string, kind: 'recognized' | 'unknown' = 'unknown') => ({ cameraId, at: ms, kind, personId: null, groupId: null });

describe("machine d'identite : declenchement, prolongation, retour au calme, repos", () => {
  it("evenement selon la gravite et l'identite", () => {
    const fire = (s: RuleSpec, obs: ReturnType<typeof seen>) => brief(idMachine(s).see(obs));
    const mine = seen(0, 'C-01', 'recognized', 'p-7', '2');
    assert.deepEqual(fire(idSpec(UNKNOWN), seen(0, 'C-01')), ['face_unknown:C-01@0']);
    assert.deepEqual(fire(idSpec(FAMILLE), mine), ['face_banned:C-01@0']);
    assert.deepEqual(fire(idSpec(AWA), mine), ['face_banned:C-01@0']);
    for (const who of [UNKNOWN, FAMILLE, AWA]) {
      const obs = who.type === 'unknown' ? seen(0, 'C-01') : mine;
      assert.deepEqual(fire(idSpec(who, { then: { severity: 'warning' } }), obs), ['face_noticed:C-01@0']);
    }
  });

  it('ne reagit pas aux autres identites ni aux cameras hors portee ; la camera designee est celle de l\'observation', () => {
    const m = idMachine(idSpec(FAMILLE));
    assert.deepEqual(brief(m.see(seen(0, 'C-01', 'unknown'))), []);
    assert.deepEqual(brief(m.see(seen(1, 'C-01', 'recognized', 'p-9', '3'))), []);
    assert.deepEqual(brief(m.see(seen(2, 'C-09', 'recognized', 'p-7', '2'))), [], 'hors portee');
    assert.equal(m.nextWake(), null);
    assert.deepEqual(brief(m.see(seen(3, 'C-02', 'recognized', 'p-7', '2'))), ['face_banned:C-02@3']);
  });

  it("prolongation : chaque observation correspondante repousse la fin ; clear a l'instant exact derniere + 60 s", () => {
    const m = idMachine(idSpec(UNKNOWN));
    assert.deepEqual(brief(m.see(seen(0, 'C-01'))), ['face_unknown:C-01@0']);
    assert.equal(m.nextWake(), at(60));
    assert.deepEqual(brief(m.see(seen(50, 'C-02'))), [], 'deja declenchee, prolonge');
    assert.equal(m.nextWake(), at(110));
    assert.deepEqual(brief(m.see(seen(100, 'C-01', 'recognized', 'p-1', '1'))), [], 'une autre identite ne prolonge pas');
    assert.equal(m.nextWake(), at(110));
    assert.deepEqual(brief(m.tick(at(109))), []);
    assert.equal(m.isTriggered(), true);
    assert.deepEqual(brief(m.tick(at(500))), ['clear@110'], 'date de la fin, pas du tick');
    assert.equal(m.isTriggered(), false);
    assert.equal(m.nextWake(), null);
  });

  it("a 60 s pile apres la derniere observation correspondante, la regle est deja finie (repos nul : nouveau declenchement)", () => {
    const m = idMachine(idSpec(UNKNOWN, { cooldownMinutes: 0 }));
    m.see(seen(0, 'C-01'));
    assert.deepEqual(brief(m.see(seen(59, 'C-01'))), [], 'prolonge : fin a 119');
    assert.deepEqual(brief(m.see(seen(118, 'C-01'))), [], '59 s apres la derniere : encore declenchee, fin a 178');
    assert.deepEqual(brief(m.see(seen(178, 'C-01'))), ['clear@178', 'face_unknown:C-01@178']);
  });

  it('repos : aucune observation ne declenche avant la fin du repos, limite incluse', () => {
    const a = idMachine(idSpec(UNKNOWN)); // repos 10 min
    a.see(seen(0, 'C-01'));
    assert.deepEqual(brief(a.tick(at(60))), ['clear@60']); // repos jusqu'a 660
    assert.deepEqual(brief(a.see(seen(659, 'C-01'))), [], 'encore au repos');
    assert.equal(a.nextWake(), null, 'une observation pendant le repos ne declenche ni ne prolonge');
    const b = idMachine(idSpec(UNKNOWN));
    b.see(seen(0, 'C-01'));
    b.tick(at(60));
    assert.deepEqual(brief(b.see(seen(660, 'C-01'))), ['face_unknown:C-01@660'], 'repos ecoule pile');
  });

  it('le repos part de la fin (derniere observation + 60 s), pas du declenchement', () => {
    const m = idMachine(idSpec(UNKNOWN, { cooldownMinutes: 5 }));
    m.see(seen(0, 'C-01'));
    m.see(seen(50, 'C-01')); // prolonge : fin a 110, repos jusqu'a 410
    assert.deepEqual(brief(m.see(seen(409, 'C-01'))), ['clear@110'], 'encore au repos : seule la fin est signalee');
    assert.deepEqual(brief(m.see(seen(410, 'C-01'))), ['face_unknown:C-01@410']);
  });

  it("release : un seul clear, pas de repos ensuite ; init ne signale rien et ignore la presence ; feed est sans effet", () => {
    const m = idMachine(idSpec(UNKNOWN));
    assert.deepEqual(brief(m.release(at(1))), []);
    m.see(seen(0, 'C-01'));
    assert.deepEqual(brief(m.release(at(5))), ['clear@5']);
    assert.equal(m.nextWake(), null);
    assert.deepEqual(brief(m.see(seen(6, 'C-01'))), ['face_unknown:C-01@6']);
    const fresh = idMachine(idSpec(UNKNOWN));
    assert.deepEqual(brief(fresh.init({ 'C-01': { since: at(-3600) } }, at(0))), []);
    assert.equal(fresh.isTriggered(), false);
    assert.deepEqual(brief(fresh.feed(change(1, 'C-01', 'start'))), [], "la presence ne pilote pas une regle d'identite");
    assert.deepEqual(brief(fresh.tick(at(5000))), []);
    assert.equal(fresh.nextWake(), null);
  });

  it("une regle « n'importe qui » ignore les visages", () => {
    const m = idMachine(spec());
    assert.deepEqual(brief(m.see(seen(0, 'C-01'))), []);
    assert.deepEqual(brief(m.see(seen(1, 'C-01', 'recognized', 'p-7', '2'))), []);
    assert.equal(m.nextWake(), null);
    assert.deepEqual(brief(m.feed(change(2, 'C-01', 'start'))), ['person_detected:C-01@2']);
  });

  it('le temps ne recule jamais', () => {
    const m = idMachine(idSpec(UNKNOWN));
    m.tick(at(100));
    assert.deepEqual(brief(m.see(seen(50, 'C-01'))), ['face_unknown:C-01@100']);
  });
});

describe("machine d'identite : periodes (when)", () => {
  const mondayNight = idSpec(UNKNOWN, { when: { type: 'windows', windows: [{ days: [1], from: '22:00', to: '06:00' }] } });
  const fires = (s: RuleSpec, day: number, h: number, m: number) => idMachine(s).see(seenAt(T0 + hms(day, h, m) * S, 'C-01')).length > 0;

  it('plage a cheval sur minuit : debut inclus, fin exclue, autre jour exclu', () => {
    assert.equal(fires(mondayNight, 0, 21, 59), false);
    assert.equal(fires(mondayNight, 0, 22, 0), true);
    assert.equal(fires(mondayNight, 1, 3, 0), true);
    assert.equal(fires(mondayNight, 1, 5, 59), true);
    assert.equal(fires(mondayNight, 1, 6, 0), false);
    assert.equal(fires(mondayNight, 1, 23, 0), false);
    assert.equal(fires(mondayNight, 0, 3, 0), false);
  });

  it('une observation hors plage est oubliee ; une observation ulterieure dans la plage declenche', () => {
    const m = idMachine(idSpec(UNKNOWN, { when: night() }));
    assert.deepEqual(brief(m.see(seenAt(at(hms(0, 20)), 'C-01'))), []);
    assert.deepEqual(brief(m.see(seenAt(at(hms(0, 22, 5)), 'C-01'))), [`face_unknown:C-01@${hms(0, 22, 5)}`]);
  });

  it('declenchee dans la plage, la regle est prolongee par une observation apres la fermeture de la plage', () => {
    const m = idMachine(idSpec(UNKNOWN, { when: night() }));
    assert.deepEqual(brief(m.see(seenAt(at(hms(1, 5, 59, 30)), 'C-01'))), [`face_unknown:C-01@${hms(1, 5, 59, 30)}`]);
    assert.deepEqual(brief(m.see(seenAt(at(hms(1, 6, 0, 20)), 'C-01'))), [], 'plage fermee mais deja declenchee : prolonge');
    assert.deepEqual(brief(m.tick(at(hms(1, 7)))), [`clear@${hms(1, 6, 1, 20)}`]);
  });

  it("zone armee : jugee sur la camera de l'observation", () => {
    const m = idMachine(idSpec(UNKNOWN, { when: { type: 'armed' } }), { 'C-02': false });
    assert.deepEqual(brief(m.see(seen(0, 'C-02'))), [], 'zone de C-02 desarmee');
    assert.deepEqual(brief(m.see(seen(5, 'C-01'))), ['face_unknown:C-01@5']);
  });
});

describe("machine d'identite : correspondance par appareil (hote)", () => {
  const base = (cameraId: string, groupId: string, personId: string) => seen(0, cameraId, 'recognized', personId, groupId);
  const listOne: Who = { type: 'list', cameraId: 'C-01', listId: '1', listName: 'Famille' };
  const personOne: Who = { type: 'person', cameraId: 'C-01', personId: '1', personName: 'Awa' };

  it('deux voies du meme enregistreur : une liste lue par C-01 reagit aux visages vus par C-02', () => {
    for (const who of [FAMILLE, AWA]) {
      const m = idMachine(idSpec(who));
      assert.deepEqual(brief(m.see(seen(0, 'C-02', 'recognized', 'p-7', '2'))), ['face_banned:C-02@0']);
    }
  });

  it('deux appareils avec la meme liste « 1 » / personne « 1 » : pas de confusion, ni pour la liste ni pour la personne', () => {
    for (const who of [listOne, personOne]) {
      const m = idMachine(idSpec(who));
      assert.deepEqual(brief(m.see(base('C-03', '1', '1'))), [], "l'autre appareil a aussi un « 1 »");
      assert.deepEqual(brief(m.see(base('C-04', '1', '1'))), [], 'un troisieme appareil non plus');
      assert.equal(m.nextWake(), null);
      assert.deepEqual(brief(m.see(base('C-01', '1', '1'))), ['face_banned:C-01@0'], 'le bon appareil declenche');
    }
    // la regle lue sur l'appareil C-03 ne reagit qu'a C-03
    const other = idMachine(idSpec({ ...listOne, cameraId: 'C-03' }));
    assert.deepEqual(brief(other.see(base('C-01', '1', '1'))), []);
    assert.deepEqual(brief(other.see(base('C-02', '1', '1'))), []);
    assert.deepEqual(brief(other.see(base('C-03', '1', '1'))), ['face_banned:C-03@0']);
  });

  it("camera du « Qui » ou de l'observation sans source / supprimee : la regle ne se declenche pas (« inconnu » reste inchange)", () => {
    const noSource = (cameraId: string) => (cameraId === 'C-01' ? null : hostOf(cameraId));
    for (const who of [FAMILLE, AWA]) {
      const m = idMachine(idSpec(who), {}, noSource);
      assert.deepEqual(brief(m.see(seen(0, 'C-02', 'recognized', 'p-7', '2'))), [], 'camera du Qui supprimee');
      assert.deepEqual(brief(m.see(seen(1, 'C-01', 'recognized', 'p-7', '2'))), []);
      assert.equal(m.nextWake(), null);
    }
    const unreadable = (cameraId: string) => (cameraId === 'C-02' ? null : hostOf(cameraId));
    assert.deepEqual(brief(idMachine(idSpec(FAMILLE), {}, unreadable).see(seen(0, 'C-02', 'recognized', 'p-7', '2'))), [], "camera de l'observation sans source");
    assert.deepEqual(brief(idMachine(idSpec(FAMILLE), {}, () => null).see(seen(0, 'C-01', 'recognized', 'p-7', '2'))), []);
    assert.deepEqual(brief(idMachine(idSpec(UNKNOWN), {}, () => null).see(seen(0, 'C-02'))), ['face_unknown:C-02@0']);
  });

  it("regle ancienne (sans cameraId) ou valeurs hostiles : la machine se construit, ne plante pas et ne declenche jamais", () => {
    const { cameraId: _gone, ...oldFamille } = FAMILLE as Extract<Who, { type: 'list' }>;
    for (const who of [oldFamille, { ...oldFamille, cameraId: null }, { ...oldFamille, cameraId: 12 }, { ...oldFamille, cameraId: {} }]) {
      const m = idMachine(idSpec(who as never));
      assert.deepEqual(brief(m.see(seen(0, 'C-01', 'recognized', 'p-7', '2'))), []);
      assert.deepEqual(brief(m.see(seen(1, 'C-02', 'recognized', 'p-7', '2'))), []);
      assert.deepEqual(brief(m.tick(at(10_000))), []);
      assert.equal(m.isTriggered(), false);
    }
  });

  it("garde de nom : un nom different ne declenche pas et previent par onMismatch (sans onMismatch, rien ne change) ; un nom egal ou absent declenche", () => {
    const named = (sec: number, cameraId: string, personId: string, groupId: string, groupName: string | null, personName: string | null = null) =>
      ({ cameraId, at: at(sec), kind: 'recognized' as const, personId, groupId, groupName, personName });
    for (const who of [FAMILLE, AWA]) {
      let mismatches = 0;
      const m = createRuleMachine(idSpec(who, { cooldownMinutes: 0 }), { cameras: ['C-01', 'C-02', 'C-03'], isArmed: () => true, hostOf, onMismatch: () => void mismatches++ });
      const wrong = who.type === 'list' ? named(0, 'C-01', 'p-7', '2', 'Visiteurs') : named(0, 'C-01', 'p-7', '2', null, 'Bob');
      assert.deepEqual(brief(m.see(wrong)), []);
      assert.equal(mismatches, 1);
      assert.equal(m.nextWake(), null);
      // un autre numero, un autre appareil : une autre liste / personne, pas un « nom different »
      m.see(named(1, 'C-01', 'p-9', '3', 'Visiteurs', 'Bob'));
      m.see(named(2, 'C-03', 'p-7', '2', 'Visiteurs', 'Bob'));
      assert.equal(mismatches, 1);
      // meme nom a la casse pres, ou sans nom : declenche, sans avertissement
      const right = who.type === 'list' ? named(10, 'C-02', 'p-7', '2', ' FAMILLE ') : named(10, 'C-02', 'p-7', '2', null, 'awa koné');
      assert.deepEqual(brief(m.see(right)), ['face_banned:C-02@10']);
      assert.deepEqual(brief(m.see(named(300, 'C-01', 'p-7', '2', null))), [`clear@70`, 'face_banned:C-01@300']);
      assert.equal(mismatches, 1);
      // sans callback : meme resultat, aucune exception
      const quiet = idMachine(idSpec(who, { cooldownMinutes: 0 }));
      assert.deepEqual(brief(quiet.see(wrong)), []);
    }
    // le nom different n'a aucun effet sur « inconnu »
    let calls = 0;
    const unknown = createRuleMachine(idSpec(UNKNOWN), { cameras: ['C-01'], isArmed: () => true, hostOf, onMismatch: () => void calls++ });
    assert.deepEqual(brief(unknown.see(seen(0, 'C-01'))), ['face_unknown:C-01@0']);
    assert.equal(calls, 0);
  });

  it("l'hote est relu a chaque observation : changer l'adresse d'une camera fait suivre la correspondance", () => {
    const hosts: Record<string, string> = { ...HOSTS };
    const m = idMachine(idSpec(FAMILLE, { cooldownMinutes: 0 }), {}, (id) => hosts[id] ?? null);
    assert.deepEqual(brief(m.see(seen(0, 'C-03', 'recognized', 'p-7', '2'))), [], 'C-03 est un autre appareil');
    hosts['C-03'] = hosts['C-01'].toUpperCase() + ' '; // C-03 rejoint l'enregistreur (casse et espace ignores)
    assert.deepEqual(brief(m.see(seen(10, 'C-03', 'recognized', 'p-7', '2'))), ['face_banned:C-03@10']);
    m.tick(at(1000)); // fin
    hosts['C-01'] = '192.0.2.99'; // l'enregistreur change d'adresse : C-02 et C-03 ne sont plus dans le meme appareil que C-01
    assert.deepEqual(brief(m.see(seen(2000, 'C-02', 'recognized', 'p-7', '2'))), []);
    assert.deepEqual(brief(m.see(seen(2001, 'C-03', 'recognized', 'p-7', '2'))), []);
    assert.deepEqual(brief(m.see(seen(2002, 'C-01', 'recognized', 'p-7', '2'))), ['face_banned:C-01@2002']);
  });
});

describe("machine d'identite : direct par ticks == essai par sauts", () => {
  it("memes actions, quelle que soit la facon d'avancer le temps (generateur a graine fixe)", () => {
    const prng = (seed: number) => {
      let x = seed >>> 0;
      return () => (x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 2 ** 32;
    };
    const specs: RuleSpec[] = [
      idSpec(UNKNOWN, { cooldownMinutes: 0 }),
      idSpec(UNKNOWN, { cooldownMinutes: 3, then: { severity: 'warning' } }),
      idSpec(FAMILLE, { cooldownMinutes: 1 }),
      idSpec(AWA, { cooldownMinutes: 5 }),
      idSpec(UNKNOWN, { when: night(), cooldownMinutes: 5 }),
      idSpec(FAMILLE, { when: { type: 'armed' }, cooldownMinutes: 2 }),
    ];
    const start = hms(0, 20);
    const end = hms(1, 4);
    let total = 0;
    for (let seed = 1; seed <= 4; seed++) {
      const rnd = prng(seed * 104729);
      const events: { sec: number; cameraId: string; kind: 'recognized' | 'unknown'; personId: string | null; groupId: string | null }[] = [];
      for (const cameraId of ['C-01', 'C-02']) {
        let t = start + Math.floor(rnd() * 600);
        while (t < end - 3600) {
          const r = rnd();
          events.push(r < 0.5 ? { sec: t, cameraId, kind: 'unknown', personId: null, groupId: null } : r < 0.75 ? { sec: t, cameraId, kind: 'recognized', personId: 'p-7', groupId: '2' } : { sec: t, cameraId, kind: 'recognized', personId: 'p-9', groupId: '2' });
          t += rnd() < 0.7 ? 5 + Math.floor(rnd() * 90) : 120 + Math.floor(rnd() * 2400);
        }
      }
      events.sort((a, b) => a.sec - b.sec);
      for (const [i, s] of specs.entries()) {
        const armed = { 'C-02': seed % 2 === 0 };
        const dense = idMachine(s, armed);
        const sparse = idMachine(s, armed);
        const sight = (e: (typeof events)[number]) => ({ cameraId: e.cameraId, at: at(e.sec), kind: e.kind, personId: e.personId, groupId: e.groupId });
        const denseOut: RuleAction[] = [];
        let k = 0;
        for (let sec = start; sec <= end; sec++) {
          while (k < events.length && events[k].sec <= sec) denseOut.push(...dense.see(sight(events[k++])));
          denseOut.push(...dense.tick(at(sec)));
        }
        const sparseOut: RuleAction[] = [];
        for (const e of events) sparseOut.push(...sparse.see(sight(e)));
        sparseOut.push(...sparse.tick(at(end)));
        assert.deepEqual(brief(denseOut), brief(sparseOut), `graine ${seed}, regle ${i}`);
        total += denseOut.length;
      }
    }
    assert.ok(total > 50, `les scenarios declenchent bien des actions (${total})`);
  });
});

// ---- 7. Regles d'identite : moteur complet (visages injectes) ---------------------------------------------------------

function fakeFaces() {
  const listeners = new Set<(s: FaceSeen) => void>();
  const log: FaceSeen[] = [];
  return {
    emit(s: FaceSeen) {
      log.push(s);
      for (const fn of [...listeners]) fn(s);
    },
    /** Historique ajoute sans prevenir personne (essai sur le passe). */
    seed(items: FaceSeen[]) {
      log.push(...items);
    },
    subscribe(fn: (s: FaceSeen) => void) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    history(from: number, to: number, cameraIds?: string[]): FaceSeen[] {
      return log
        .filter((s) => s.at >= from && s.at <= to && (!cameraIds || cameraIds.includes(s.cameraId)))
        .map((s, i) => ({ s, i }))
        .sort((a, b) => a.s.at - b.s.at || a.i - b.i)
        .map((x) => x.s);
    },
    listenerCount: () => listeners.size,
  };
}
const face = (ms: number, cameraId: string, kind: 'recognized' | 'unknown' = 'unknown', personId: string | null = null, groupId: string | null = null): FaceSeen => ({
  cameraId,
  at: ms,
  kind,
  personId,
  personName: personId ? 'Awa Koné' : null,
  groupId,
  groupName: groupId ? 'Famille' : null,
  similarity: kind === 'recognized' ? 90 : null,
});

type FaceScript = [sec: number, cameraId: string, kind?: 'recognized' | 'unknown', personId?: string | null, groupId?: string | null][];

function faceSetup(opts: { withFaces?: boolean; armed?: Record<string, boolean> } = {}) {
  const h = setup({ armed: opts.armed });
  h.rules.close(); // le moteur de setup() n'a pas de visages : on en monte un autre sur la meme base
  const faces = fakeFaces();
  let current = T0;
  const sent: { sec: number; deviceId: string; event: string }[] = [];
  const engine = {
    handleDetectorMessage: (deviceId: string, payload: unknown) => {
      sent.push({ sec: (current - T0) / S, deviceId, event: (payload as { event: string }).event });
      h.engine.handleDetectorMessage(deviceId, payload);
    },
    audit: h.engine.audit,
    getDevice: h.engine.getDevice,
    createDevice: h.engine.createDevice,
    updateDevice: h.engine.updateDevice,
    deleteDevice: h.engine.deleteDevice,
    setLinks: h.engine.setLinks,
    getSnapshot: h.engine.getSnapshot,
  };
  // Sources video des cameras de test (HOSTS) : sans elles, aucune regle liste / personne ne peut etre enregistree.
  for (const [id, host] of Object.entries(HOSTS)) {
    h.db.prepare("INSERT INTO camera_source (device_id, kind, host, port, rtsp_path) VALUES (?, 'rtsp', ?, 554, ?)").run(id, host, `/cam/realmonitor?channel=${Number(id.slice(2))}&subtype=0`);
  }
  const build = () => createRules({ db: h.db, engine, presence: h.presence, faces: opts.withFaces === false ? undefined : faces, isArmed: (zone) => h.armed[zone] !== false, now: () => current });
  const out = {
    h,
    faces,
    rules: build(),
    /** Redemarrage du PSIM : memes donnees, nouveau moteur de regles (relecture et reconciliation). */
    restart(): ReturnType<typeof build> {
      out.rules.close();
      out.rules = build();
      return out.rules;
    },
    sent,
    triggers: () => sent.filter((m) => m.event !== 'clear'),
    set: (sec: number) => {
      current = T0 + sec * S;
    },
    /** Avance seconde par seconde de `from` a `until`, en jouant les visages du scenario et un tick par seconde. */
    play(script: FaceScript, from: number, until: number) {
      const todo = script.map((e, i) => ({ e, i })).sort((a, b) => a.e[0] - b.e[0] || a.i - b.i).map((x) => x.e);
      let k = 0;
      for (let s = from; s <= until; s++) {
        current = T0 + s * S;
        while (k < todo.length && todo[k][0] <= s) {
          const [, cam, kind, pid, gid] = todo[k++];
          faces.emit(face(current, cam, kind ?? 'unknown', pid ?? null, gid ?? null));
        }
        out.rules.tick();
      }
    },
    status: (id: string) => h.engine.getDevice(id)?.status,
  };
  return out;
}

describe("regles d'identite : direct, detecteur et essai sur le passe", () => {
  it('un visage inconnu ouvre un incident critique (face_unknown) sur R-1, retour a la normale 60 s apres la derniere observation', () => {
    const f = faceSetup();
    f.rules.create('admin', { name: 'Inconnus cour', spec: idSpec(UNKNOWN, { where: { cameras: ['C-01', 'C-02'] } }) });
    f.play([[0, 'C-01'], [30, 'C-02']], 0, 89);
    assert.equal(f.status('R-1'), 'alarm');
    const [incident] = f.h.engine.getSnapshot().incidents;
    assert.equal(incident.event, 'face_unknown');
    assert.equal(incident.severity, 'critical');
    assert.equal(incident.detectorId, 'R-1');
    f.play([], 90, 90);
    assert.equal(f.status('R-1'), 'normal');
    assert.deepEqual(f.sent.map((m) => `${m.sec}:${m.event}`), ['0:face_unknown', '90:clear']);
  });

  it('liste / personne = face_banned, avertissement = face_noticed (pre-alarme) ; les autres visages sont sans effet', () => {
    const f = faceSetup();
    f.rules.create('admin', { name: 'Famille', spec: idSpec(FAMILLE, { where: { cameras: ['C-01'] }, then: { severity: 'warning' } }) });
    f.rules.create('admin', { name: 'Awa', spec: idSpec(AWA, { where: { cameras: ['C-02'] } }) });
    f.play([[0, 'C-01', 'recognized', 'p-1', '3'], [1, 'C-01', 'unknown'], [2, 'C-02', 'recognized', 'p-7', '2']], 0, 3);
    assert.deepEqual(f.sent.map((m) => `${m.deviceId}:${m.event}`), ['R-2:face_banned']);
    assert.equal(f.status('R-1'), 'normal');
    f.play([[10, 'C-01', 'recognized', 'p-1', '2']], 4, 11);
    assert.equal(f.status('R-1'), 'prealarm');
    const noticed = f.h.engine.getSnapshot().incidents.find((i) => i.detectorId === 'R-1')!;
    assert.equal(noticed.severity, 'warning');
    assert.equal(noticed.event, 'face_noticed');
  });

  it("les regles « n'importe qui » ne recoivent pas les visages, et les regles d'identite ne recoivent pas la presence", () => {
    const f = faceSetup();
    f.rules.create('admin', { name: 'Presence', spec: spec() });
    f.rules.create('admin', { name: 'Inconnus', spec: idSpec(UNKNOWN) });
    f.play([[0, 'C-01']], 0, 1);
    assert.deepEqual(f.sent.map((m) => m.deviceId), ['R-2']);
    f.set(100);
    f.h.presence.emit({ cameraId: 'C-01', kind: 'start', at: T0 + 100 * S, source: 'test' });
    assert.deepEqual(f.sent.map((m) => m.deviceId), ['R-2', 'R-1']);
  });

  it("sans `faces`, une regle d'identite vit mais ne recoit rien, et son essai ne declenche rien", () => {
    const f = faceSetup({ withFaces: false });
    f.rules.create('admin', { name: 'Inconnus', spec: idSpec(UNKNOWN) });
    assert.equal(f.faces.listenerCount(), 0);
    f.faces.emit(face(T0, 'C-01'));
    f.play([], 0, 5);
    assert.equal(f.sent.length, 0);
    assert.ok(f.h.engine.getDevice('R-1'));
    assert.deepEqual(f.rules.simulate(idSpec(UNKNOWN), T0, at(60)).triggers, []);
  });

  it('close() desabonne aussi les visages', () => {
    const f = faceSetup();
    assert.equal(f.faces.listenerCount(), 1);
    f.rules.close();
    assert.equal(f.faces.listenerCount(), 0);
  });

  it("desactivation pendant l'alarme : clear ; reactivee, elle reagit", () => {
    const f = faceSetup();
    const rule = f.rules.create('admin', { name: 'Inconnus', spec: idSpec(UNKNOWN) });
    f.play([[0, 'C-01']], 0, 5);
    assert.equal(f.status('R-1'), 'alarm');
    f.rules.update('admin', rule.id, { enabled: false });
    assert.equal(f.status('R-1'), 'normal');
    f.play([[6, 'C-01']], 6, 20);
    assert.equal(f.triggers().length, 1, 'desactivee : aucune reaction');
    f.rules.update('admin', rule.id, { enabled: true });
    f.play([[30, 'C-01']], 21, 31);
    assert.equal(f.triggers().length, 2);
  });

  it("une regle d'identite ne peut etre ni creee ni modifiee avec « reste » (400)", () => {
    const f = faceSetup();
    assert.throws(() => f.rules.create('admin', { name: 'x', spec: stays(5, { who: UNKNOWN }) }), (e: unknown) => e instanceof PsimError && e.status === 400 && /seul « apparait »/.test(e.message));
    const rule = f.rules.create('admin', { name: 'ok', spec: idSpec(UNKNOWN) });
    assert.throws(() => f.rules.update('admin', rule.id, { spec: stays(5, { who: UNKNOWN }) }), /seul « apparait »/);
    assert.deepEqual((f.rules.get(rule.id)!.spec as RuleSpec).who, UNKNOWN);
    assert.match(f.rules.get(rule.id)!.summary, /si un visage inconnu est vu devant la caméra/);
  });

  it('essai sur le passe == direct : memes declenchements et memes fins ; sans effet de bord', () => {
    const script: FaceScript = [
      [0, 'C-01'], [40, 'C-02'], [95, 'C-01', 'recognized', 'p-7', '2'], // une seule alarme, fin a 100 (le visage reconnu ne prolonge pas)
      [200, 'C-01'], // repos ou non selon la regle
      [800, 'C-02'], [850, 'C-01'], [1000, 'C-01'],
    ];
    for (const s of [idSpec(UNKNOWN, { where: { cameras: ['C-01', 'C-02'] } }), idSpec(UNKNOWN, { where: { zones: ['Accueil', 'Couloir'] }, cooldownMinutes: 3 })]) {
      const f = faceSetup();
      f.rules.create('admin', { name: 'Inconnus', spec: s });
      f.play(script, 0, 1500);
      const count = (t: string) => (f.h.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
      const before = { audit: count('audit_log'), incident: count('incident'), sent: f.sent.length };
      const sim = f.rules.simulate(s, T0, at(1500));
      const liveTriggers = f.triggers().map((m) => m.sec);
      const liveClears = f.sent.filter((m) => m.event === 'clear').map((m) => m.sec);
      // le faux enregistreur de visages memorise ce qu'il a emis : l'historique est celui du direct
      assert.deepEqual(sim.triggers.map((t) => (t.at - T0) / S), liveTriggers);
      assert.deepEqual(sim.triggers.map((t) => (t.endedAt === null ? null : (t.endedAt - T0) / S)), liveClears);
      assert.ok(liveTriggers.length >= 2, 'le scenario declenche plusieurs fois');
      assert.deepEqual({ audit: count('audit_log'), incident: count('incident'), sent: f.sent.length }, before);
    }
  });

  it("essai : fin retrouvee au-dela de la periode, filtre par les cameras de la portee, phrase d'identite", () => {
    const f = faceSetup();
    f.faces.seed([face(at(10), 'C-01'), face(at(60), 'C-01'), face(at(30), 'C-04'), face(at(5000), 'C-01')]);
    const sim = f.rules.simulate(idSpec(UNKNOWN), T0, at(100));
    assert.deepEqual(sim.triggers, [{ at: at(10), endedAt: at(120), cameraId: 'C-01' }]);
    assert.match(sim.summary, /si un visage inconnu est vu devant la caméra « Camera accueil »/);
    assert.deepEqual(f.rules.simulate(idSpec(AWA), T0, at(100)).triggers, [], 'personne differente');
  });
});

// ---- 8. Regles d'identite : appareil du « Qui » (moteur complet) -------------------------------------------------------

const REVIEW = /Cette regle doit etre reenregistree : choisissez a nouveau la liste/;
const refused = (fn: () => unknown, pattern: RegExp) => assert.throws(fn, (e: unknown) => e instanceof PsimError && e.status === 400 && pattern.test(e.message), `devait etre refuse : ${pattern}`);
const secs = (list: { at: number }[]) => list.map((t) => (t.at - T0) / S);

describe("regles d'identite par appareil : direct, essai et changement d'adresse", () => {
  it('deux appareils ayant la meme liste « 2 » ne se confondent pas ; le direct et l\'essai donnent le meme declenchement', () => {
    const s = idSpec(FAMILLE, { where: { cameras: ['C-01', 'C-02', 'C-03'] }, cooldownMinutes: 3 });
    const f = faceSetup();
    f.rules.create('admin', { name: 'Famille', spec: s });
    f.play(
      [
        [0, 'C-03', 'recognized', 'p-7', '2'], // la liste « 2 » de l'AUTRE appareil : rien
        [20, 'C-02', 'recognized', 'p-7', '2'], // autre voie du meme enregistreur : declenche
        [400, 'C-03', 'recognized', 'p-7', '2'], // rien
        [900, 'C-01', 'recognized', 'p-9', '2'], // declenche
        [1000, 'C-03', 'recognized', 'p-7', '2'], // rien (prolongation d'une autre identite)
      ],
      0,
      1500,
    );
    assert.deepEqual(f.triggers().map((m) => m.sec), [20, 900]);
    assert.deepEqual(f.sent.filter((m) => m.event === 'clear').map((m) => m.sec), [80, 960]);
    const sim = f.rules.simulate(s, T0, at(1500));
    assert.deepEqual(secs(sim.triggers), [20, 900], "l'essai donne les memes declenchements que le direct");
    assert.deepEqual(sim.triggers.map((t) => (t.endedAt === null ? null : (t.endedAt - T0) / S)), [80, 960]);
    assert.deepEqual(sim.triggers.map((t) => t.cameraId), ['C-02', 'C-01']);
    assert.match(sim.summary, /« Famille » \(caméra « Camera accueil »\) est reconnue/);
  });

  it("une personne : meme identifiant sur deux appareils, seule celle de l'appareil de la regle declenche (direct == essai)", () => {
    const s = idSpec({ ...AWA, personId: '1' } as Who, { where: { cameras: ['C-01', 'C-03'] }, cooldownMinutes: 0 });
    const f = faceSetup();
    f.rules.create('admin', { name: 'Awa', spec: s });
    f.play([[0, 'C-03', 'recognized', '1', '1'], [100, 'C-01', 'recognized', '1', '1'], [300, 'C-03', 'recognized', '1', '1']], 0, 500);
    assert.deepEqual(f.triggers().map((m) => m.sec), [100]);
    assert.deepEqual(secs(f.rules.simulate(s, T0, at(500)).triggers), [100]);
  });

  it("changer l'adresse d'une camera (UPDATE camera_source SET host) fait suivre la correspondance, en direct comme en essai", () => {
    const s = idSpec(FAMILLE, { where: { cameras: ['C-01', 'C-02', 'C-03'] }, cooldownMinutes: 0 });
    const f = faceSetup();
    const setHost = (id: string, host: string) => f.h.db.prepare('UPDATE camera_source SET host = ? WHERE device_id = ?').run(host, id);
    f.rules.create('admin', { name: 'Famille', spec: s });
    f.play([[0, 'C-03', 'recognized', 'p-7', '2']], 0, 5);
    assert.equal(f.triggers().length, 0, 'C-03 est un autre appareil');
    assert.deepEqual(f.rules.simulate(s, T0, at(5)).triggers, []);

    setHost('C-03', '192.0.2.10'); // C-03 rejoint l'enregistreur de C-01
    assert.deepEqual(secs(f.rules.simulate(s, T0, at(5)).triggers), [0], "l'essai suit le nouvel hote");
    f.play([[10, 'C-03', 'recognized', 'p-7', '2']], 6, 12);
    assert.deepEqual(f.triggers().map((m) => m.sec), [10], 'le direct aussi, sans redemarrer');
    f.play([], 13, 80); // retour au calme

    setHost('C-01', '192.0.2.99'); // l'enregistreur de la liste change d'adresse : C-02 et C-03 n'y sont plus
    f.play([[200, 'C-02', 'recognized', 'p-7', '2'], [201, 'C-03', 'recognized', 'p-7', '2']], 81, 210);
    assert.deepEqual(f.triggers().map((m) => m.sec), [10], 'plus aucune correspondance');
    f.play([[300, 'C-01', 'recognized', 'p-7', '2']], 211, 310);
    assert.deepEqual(f.triggers().map((m) => m.sec), [10, 300]);
    assert.equal(f.rules.get(1)!.needsReview, false, "l'adresse a change mais la camera a toujours une source");
  });

  it("garde de nom : une camera deplacee vers un appareil dont la liste (ou personne) « 2 » porte un autre nom ne correspond pas, en direct comme en essai ; un seul avertissement par vie du direct", () => {
    for (const who of [FAMILLE, AWA] as Who[]) {
      const isList = who.type === 'list';
      const f = faceSetup();
      const s = idSpec(who, { where: { cameras: ['C-01', 'C-02', 'C-03'] }, cooldownMinutes: 0 });
      const rule = f.rules.create('admin', { name: 'Identite', spec: s });
      const visitor = (sec: number, cameraId: string): FaceSeen => ({ ...face(at(sec), cameraId, 'recognized', 'p-7', '2'), groupName: 'Visiteurs', personName: 'Bob' });
      const right = (sec: number, cameraId: string): FaceSeen => face(at(sec), cameraId, 'recognized', 'p-7', '2');
      const warnings: string[] = [];
      const original = console.warn;
      console.warn = (...args: unknown[]) => void warnings.push(args.join(' '));
      try {
        f.h.db.prepare("UPDATE camera_source SET host = '192.0.2.10' WHERE device_id = 'C-03'").run(); // C-03 rejoint l'appareil de C-01
        const emit = (face: FaceSeen) => {
          f.set((face.at - T0) / S);
          f.faces.emit(face);
        };
        // Un visage « liste 2 / personne p-7 » mais d'une AUTRE liste (nom different) : pas de correspondance, meme appareil, meme numero.
        emit(visitor(10, 'C-03'));
        emit(visitor(20, 'C-03'));
        emit(visitor(30, 'C-02'));
        assert.equal(f.triggers().length, 0);
        assert.equal(warnings.length, 1, 'un seul avertissement malgre trois observations');
        const what = isList ? 'la liste « Famille »' : 'la personne « Awa Koné »';
        assert.equal(warnings[0], `[rules] regle ${rule.id} : ${what} n'est plus trouvee sur l'appareil de la camera « Camera accueil » : reenregistrez la regle`);
        // Essai sur le passe : meme verdict, et il ne journalise rien.
        assert.deepEqual(f.rules.simulate(s, T0, at(100)).triggers, []);
        assert.equal(warnings.length, 1, "l'essai ne journalise rien");
        // Le bon nom (ou aucun nom) correspond toujours, en direct comme en essai.
        emit(right(200, 'C-03'));
        emit({ ...right(400, 'C-02'), groupName: null, personName: null });
        assert.deepEqual(f.triggers().map((m) => m.sec), [200, 400]);
        assert.deepEqual(secs(f.rules.simulate(s, T0, at(500)).triggers), [200, 400], "l'essai donne les memes declenchements que le direct");
        assert.equal(warnings.length, 1);
        // Reconstruction du direct (redemarrage, ou modification de la regle) : l'avertissement peut revenir, une fois.
        f.restart();
        emit(visitor(600, 'C-03'));
        emit(visitor(610, 'C-03'));
        assert.equal(warnings.length, 2);
        f.rules.update('admin', rule.id, { spec: idSpec(who, { where: { cameras: ['C-01', 'C-02', 'C-03'] }, cooldownMinutes: 1 }) });
        emit(visitor(700, 'C-03'));
        emit(visitor(710, 'C-03'));
        assert.equal(warnings.length, 3);
        assert.equal(f.triggers().length, 2, 'les observations au mauvais nom ne declenchent jamais');
        // Une autre liste (autre numero) ou un autre appareil ne produit aucun avertissement : ce n'est pas la meme liste renommee.
        emit({ ...visitor(800, 'C-03'), groupId: '9', personId: 'p-9' });
        emit(visitor(810, 'C-04'));
        assert.equal(warnings.length, 3);
      } finally {
        console.warn = original;
      }
    }
  });

  it("camera du « Qui » supprimee ou sans source : needsReview, la regle ne declenche plus, ne se reactive pas, mais se desactive / se renomme / se supprime", () => {
    const f = faceSetup();
    const rule = f.rules.create('admin', { name: 'Famille', spec: idSpec(FAMILLE, { where: { cameras: ['C-01', 'C-02'] }, cooldownMinutes: 0 }) });
    assert.equal(rule.needsReview, false);
    f.h.db.prepare("DELETE FROM camera_source WHERE device_id = 'C-01'").run();
    assert.equal(f.rules.get(rule.id)!.needsReview, true);
    assert.equal(f.rules.list()[0].needsReview, true);
    f.play([[0, 'C-02', 'recognized', 'p-7', '2'], [1, 'C-01', 'recognized', 'p-7', '2']], 0, 5);
    assert.equal(f.triggers().length, 0, 'sans source, rien ne correspond');
    // activation refusee (apres une desactivation, qui reste possible)
    f.rules.update('admin', rule.id, { enabled: false });
    refused(() => f.rules.update('admin', rule.id, { enabled: true }), REVIEW);
    assert.equal(f.rules.get(rule.id)!.enabled, false);
    assert.equal(f.rules.update('admin', rule.id, { name: 'Famille a refaire' }).name, 'Famille a refaire');
    // la source revient : la regle est de nouveau valide telle quelle
    f.h.db.prepare("INSERT INTO camera_source (device_id, kind, host, port, rtsp_path) VALUES ('C-01', 'rtsp', '192.0.2.10', 554, '/cam/realmonitor?channel=1&subtype=0')").run();
    assert.equal(f.rules.get(rule.id)!.needsReview, false);
    assert.equal(f.rules.update('admin', rule.id, { enabled: true }).enabled, true);
    f.rules.remove('admin', rule.id);
    assert.equal(f.rules.list().length, 0);
  });
});

describe("regles d'identite anciennes (sans cameraId) : chargement, needsReview, reenregistrement", () => {
  /** Regle creee normalement puis ramenee a l'ancienne forme dans la base (comme avant l'ajout de la camera source). */
  function legacySetup(opts: { enabled?: boolean; who?: Who } = {}) {
    const f = faceSetup();
    const rule = f.rules.create('admin', { name: 'Famille', spec: idSpec(opts.who ?? FAMILLE, { where: { cameras: ['C-01', 'C-02'] }, cooldownMinutes: 0 }), enabled: opts.enabled ?? true });
    const old = JSON.parse(JSON.stringify(rule.spec)) as { who: Record<string, unknown> };
    delete old.who.cameraId;
    f.h.db.prepare('UPDATE presence_rule SET spec = ? WHERE id = ?').run(JSON.stringify(old), rule.id);
    return { f, id: rule.id };
  }

  it('au redemarrage, une regle activee sans cameraId se charge sans planter, est a reenregistrer et ne declenche rien', () => {
    for (const who of [FAMILLE, AWA]) {
      const { f, id } = legacySetup({ who });
      const errors: unknown[][] = [];
      const original = console.error;
      console.error = (...args: unknown[]) => void errors.push(args);
      let rules: ReturnType<typeof f.restart>;
      try {
        rules = f.restart();
        f.play([[0, 'C-01', 'recognized', 'p-7', '2'], [1, 'C-02', 'recognized', 'p-7', '2']], 0, 120);
      } finally {
        console.error = original;
      }
      assert.deepEqual(errors, [], 'aucune erreur journalisee');
      const loaded = rules.get(id)!;
      assert.equal(loaded.needsReview, true);
      assert.equal(loaded.enabled, true);
      assert.match(loaded.summary, /\(caméra non précisée\) est reconnue/);
      assert.equal(rules.list().length, 1);
      assert.equal(f.triggers().length, 0, 'ne declenche plus');
      assert.equal(f.status(loaded.deviceId), 'normal');
      assert.deepEqual(secs(rules.simulate(idSpec(who), T0, at(60)).triggers), [0], "l'essai d'une saisie valide, lui, rejoue les visages deja vus");
    }
  });

  it("l'activation d'une regle a reenregistrer est refusee (400), la desactivation, le renommage et la suppression restent possibles", () => {
    const { f, id } = legacySetup({ enabled: false });
    const rules = f.restart();
    assert.equal(rules.get(id)!.needsReview, true);
    refused(() => rules.update('admin', id, { enabled: true }), REVIEW);
    refused(() => rules.update('admin', id, { name: 'Autre nom', enabled: true }), REVIEW);
    assert.equal(rules.get(id)!.enabled, false);
    assert.equal(rules.get(id)!.name, 'Famille', "rien n'a ete modifie par la demande refusee");
    assert.equal(rules.update('admin', id, { name: 'Famille (ancienne)' }).name, 'Famille (ancienne)');
    assert.equal(rules.update('admin', id, { enabled: false }).enabled, false, 'deja desactivee : sans effet');
    rules.remove('admin', id);
    assert.equal(rules.list().length, 0);

    // activee : on peut la desactiver, puis plus la reactiver telle quelle
    const second = legacySetup();
    const again = second.f.restart();
    assert.equal(again.update('admin', second.id, { enabled: true }).enabled, true, 'deja activee : pas une activation');
    assert.equal(again.update('admin', second.id, { enabled: false }).enabled, false);
    refused(() => again.update('admin', second.id, { enabled: true }), REVIEW);
  });

  it("un nouveau spec valide la reenregistre normalement (et peut l'activer) ; un spec invalide est refuse", () => {
    const { f, id } = legacySetup({ enabled: false });
    const rules = f.restart();
    refused(() => rules.update('admin', id, { spec: { ...idSpec(FAMILLE), who: { type: 'list', listId: '2', listName: 'Famille' } }, enabled: true }), /la camera de la liste est requise/);
    refused(() => rules.update('admin', id, { spec: idSpec({ ...FAMILLE, cameraId: 'C-99' } as Who), enabled: true }), /camera inconnue « C-99 »/);
    assert.equal(rules.get(id)!.enabled, false);
    const fixed = rules.update('admin', id, { spec: idSpec(FAMILLE, { where: { cameras: ['C-01', 'C-02'] }, cooldownMinutes: 0 }), enabled: true });
    assert.equal(fixed.needsReview, false);
    assert.equal(fixed.enabled, true);
    assert.match(fixed.summary, /« Famille » \(caméra « Camera accueil »\) est reconnue/);
    f.play([[10, 'C-02', 'recognized', 'p-7', '2']], 0, 15);
    assert.deepEqual(f.triggers().map((m) => m.sec), [10]);
    // et la regle redevient modifiable normalement
    assert.equal(rules.update('admin', id, { enabled: false }).enabled, false);
    assert.equal(rules.update('admin', id, { enabled: true }).enabled, true);
  });

  it('un nouveau spec seul (sans enabled) sur une regle activee ancienne la rebranche', () => {
    const { f, id } = legacySetup();
    const rules = f.restart();
    assert.equal(rules.get(id)!.needsReview, true);
    rules.update('admin', id, { spec: idSpec(FAMILLE, { where: { cameras: ['C-01', 'C-02'] }, cooldownMinutes: 0 }) });
    assert.equal(rules.get(id)!.needsReview, false);
    f.play([[5, 'C-01', 'recognized', 'p-7', '2']], 0, 8);
    assert.deepEqual(f.triggers().map((m) => m.sec), [5]);
  });

  it("la regle « inconnu » et « n'importe qui » ne sont jamais a reenregistrer", () => {
    const f = faceSetup();
    f.rules.create('admin', { name: 'Inconnus', spec: idSpec(UNKNOWN) });
    f.rules.create('admin', { name: 'Presence', spec: spec() });
    assert.deepEqual(f.rules.list().map((r) => r.needsReview), [false, false]);
  });
});

describe("regles d'identite : la portee doit contenir une camera de l'appareil du « Qui »", () => {
  const FAMILLE_REFUS = /Ou : aucune camera choisie n'appartient a l'appareil de la liste « Famille » \(camera « Camera accueil »\) : elle ne pourrait jamais se declencher/;
  const AWA_REFUS = /Ou : aucune camera choisie n'appartient a l'appareil de la personne « Awa Koné » \(camera « Camera accueil »\) : elle ne pourrait jamais se declencher/;

  it('create : cameras ou zones sur un autre appareil => refus 400 sans aucune trace', () => {
    const f = faceSetup();
    const devices = f.h.engine.getSnapshot().devices.length;
    refused(() => f.rules.create('admin', { name: 'x', spec: idSpec(FAMILLE, { where: { cameras: ['C-03'] } }) }), FAMILLE_REFUS);
    refused(() => f.rules.create('admin', { name: 'x', spec: idSpec(FAMILLE, { where: { cameras: ['C-03', 'C-04'] } }) }), FAMILLE_REFUS);
    refused(() => f.rules.create('admin', { name: 'x', spec: idSpec(AWA, { where: { cameras: ['C-04'] } }) }), AWA_REFUS);
    refused(() => f.rules.create('admin', { name: 'x', spec: idSpec(FAMILLE, { where: { zones: ['Salle serveurs'] } }) }), FAMILLE_REFUS);
    refused(() => f.rules.create('admin', { name: 'x', spec: idSpec(FAMILLE, { where: { zones: ['Salle serveurs', 'Entrepot'] } }) }), FAMILLE_REFUS);
    assert.equal(f.rules.list().length, 0);
    assert.equal(f.h.engine.getSnapshot().devices.length, devices, 'aucun detecteur cree');
  });

  it("une camera sur le bon appareil (autre voie) suffit, par camera comme par zone, meme parmi d'autres appareils", () => {
    const f = faceSetup();
    assert.doesNotThrow(() => f.rules.create('admin', { name: 'a', spec: idSpec(FAMILLE, { where: { cameras: ['C-02'] } }) })); // autre voie
    assert.doesNotThrow(() => f.rules.create('admin', { name: 'b', spec: idSpec(FAMILLE, { where: { cameras: ['C-01'] } }) })); // la camera elle-meme
    assert.doesNotThrow(() => f.rules.create('admin', { name: 'c', spec: idSpec(FAMILLE, { where: { cameras: ['C-03', 'C-02'] } }) })); // une seule suffit
    assert.doesNotThrow(() => f.rules.create('admin', { name: 'd', spec: idSpec(FAMILLE, { where: { zones: ['Couloir'] } }) })); // zone de C-02
    assert.doesNotThrow(() => f.rules.create('admin', { name: 'e', spec: idSpec(AWA, { where: { zones: ['Salle serveurs', 'Couloir'] } }) }));
    assert.equal(f.rules.list().length, 5);
  });

  it("la camera du « Qui » sans source video (ou une zone sans camera de cet appareil) est refusee ; « inconnu » et « n'importe qui » ne sont pas concernes", () => {
    const f = faceSetup();
    refused(() => f.rules.create('admin', { name: 'x', spec: idSpec({ ...FAMILLE, cameraId: 'C-05' } as Who, { where: { cameras: ['C-05'] } }) }), /Qui : la camera « Camera atelier » de la liste « Famille » n'est reliee a aucun appareil/);
    refused(() => f.rules.create('admin', { name: 'x', spec: idSpec({ ...FAMILLE, cameraId: 'C-05' } as Who, { where: { cameras: ['C-01'] } }) }), /n'est reliee a aucun appareil/);
    refused(() => f.rules.create('admin', { name: 'x', spec: idSpec({ ...AWA, cameraId: 'C-05' } as Who) }), /de la personne « Awa Koné » n'est reliee a aucun appareil/);
    assert.doesNotThrow(() => f.rules.create('admin', { name: 'u', spec: idSpec(UNKNOWN, { where: { cameras: ['C-03', 'C-05'] } }) }));
    assert.doesNotThrow(() => f.rules.create('admin', { name: 'p', spec: spec({ where: { cameras: ['C-05'] } }) }));
  });

  it("update : un spec fourni est verifie de la meme facon ; sans spec, rien n'est reverifie", () => {
    const f = faceSetup();
    const rule = f.rules.create('admin', { name: 'Famille', spec: idSpec(FAMILLE, { where: { cameras: ['C-01', 'C-03'] } }) });
    refused(() => f.rules.update('admin', rule.id, { spec: idSpec(FAMILLE, { where: { cameras: ['C-03'] } }) }), FAMILLE_REFUS);
    refused(() => f.rules.update('admin', rule.id, { spec: idSpec(FAMILLE, { where: { zones: ['Entrepot'] } }) }), FAMILLE_REFUS);
    assert.deepEqual(f.rules.get(rule.id)!.spec.where, { cameras: ['C-01', 'C-03'] }, 'regle inchangee');
    assert.deepEqual(f.rules.update('admin', rule.id, { spec: idSpec(FAMILLE, { where: { cameras: ['C-02', 'C-04'] } }) }).spec.where, { cameras: ['C-02', 'C-04'] });
    // une camera deplacee sur un autre appareil APRES l'enregistrement n'empeche ni renommage ni desactivation
    f.h.db.prepare("UPDATE camera_source SET host = '192.0.2.77' WHERE device_id IN ('C-02', 'C-04')").run();
    assert.equal(f.rules.update('admin', rule.id, { name: 'Famille 2' }).name, 'Famille 2');
    assert.equal(f.rules.update('admin', rule.id, { enabled: false }).enabled, false);
    assert.equal(f.rules.update('admin', rule.id, { enabled: true }).enabled, true);
  });

  it("une regle deja enregistree dont la portee n'a plus l'appareil se charge sans erreur (rien n'est verifie au chargement)", () => {
    const f = faceSetup();
    const rule = f.rules.create('admin', { name: 'Famille', spec: idSpec(FAMILLE, { where: { cameras: ['C-02'] } }) });
    f.h.db.prepare("UPDATE camera_source SET host = '192.0.2.77' WHERE device_id = 'C-02'").run();
    const errors: unknown[][] = [];
    const original = console.error;
    const warn = console.warn;
    console.error = (...args: unknown[]) => void errors.push(args);
    console.warn = (...args: unknown[]) => void errors.push(args);
    try {
      const rules = f.restart();
      assert.equal(rules.get(rule.id)!.enabled, true);
      assert.equal(rules.get(rule.id)!.needsReview, false);
      f.play([[0, 'C-02', 'recognized', 'p-7', '2']], 0, 3);
    } finally {
      console.error = original;
      console.warn = warn;
    }
    assert.deepEqual(errors, []);
    assert.equal(f.triggers().length, 0, "elle ne declenche pas : l'appareil de C-02 n'est plus celui de C-01");
  });

  it('simulate applique la meme verification', () => {
    const f = faceSetup();
    refused(() => f.rules.simulate(idSpec(FAMILLE, { where: { cameras: ['C-03'] } }), T0, at(60)), FAMILLE_REFUS);
    refused(() => f.rules.simulate(idSpec(AWA, { where: { zones: ['Entrepot'] } }), T0, at(60)), AWA_REFUS);
    refused(() => f.rules.simulate(idSpec({ ...FAMILLE, cameraId: 'C-05' } as Who), T0, at(60)), /n'est reliee a aucun appareil/);
    assert.deepEqual(f.rules.simulate(idSpec(FAMILLE, { where: { cameras: ['C-02'] } }), T0, at(60)).triggers, []);
  });

  it('validate() : validateSpec + portee + verification, sans effet de bord', () => {
    const f = faceSetup();
    const count = (t: string) => (f.h.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    const before = { audit: count('audit_log'), rule: count('presence_rule'), devices: f.h.engine.getSnapshot().devices.length, sent: f.sent.length };
    const good = idSpec(FAMILLE, { where: { zones: ['Couloir', 'Couloir'] } });
    assert.deepEqual(f.rules.validate(good), { ...good, where: { zones: ['Couloir'] } }, 'spec normalisee (doublons retires)');
    assert.deepEqual(f.rules.validate(spec()), spec());
    assert.deepEqual((f.rules.validate(idSpec(UNKNOWN, { where: { cameras: ['C-03'] } })) as RuleSpec).who, UNKNOWN);
    refused(() => f.rules.validate(idSpec(FAMILLE, { where: { cameras: ['C-04'] } })), FAMILLE_REFUS); // autre appareil
    refused(() => f.rules.validate(idSpec(AWA, { where: { zones: ['Salle serveurs'] } })), AWA_REFUS); // zone sur un autre appareil
    refused(() => f.rules.validate(idSpec({ ...FAMILLE, cameraId: 'C-05' } as Who)), /n'est reliee a aucun appareil/);
    refused(() => f.rules.validate(idSpec({ type: 'list', listId: '2', listName: 'F' } as never)), /la camera de la liste est requise/);
    refused(() => f.rules.validate(spec({ where: { cameras: ['C-99'] } })), /camera inconnue « C-99 »/);
    refused(() => f.rules.validate(spec({ where: { zones: ['Cave'] } })), /zone inconnue « Cave »/);
    refused(() => f.rules.validate(null), /objet est attendu/);
    refused(() => f.rules.validate(stays(5, { who: FAMILLE })), /seul « apparait »/);
    assert.deepEqual({ audit: count('audit_log'), rule: count('presence_rule'), devices: f.h.engine.getSnapshot().devices.length, sent: f.sent.length }, before);
    // la verification suit le hote courant
    f.h.db.prepare("UPDATE camera_source SET host = '192.0.2.10' WHERE device_id = 'C-04'").run();
    assert.doesNotThrow(() => f.rules.validate(idSpec(FAMILLE, { where: { cameras: ['C-04'] } })));
  });
});
