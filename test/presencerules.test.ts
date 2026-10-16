import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { openDb } from '../server/db.ts';
import { createEngine, PsimError } from '../server/engine.ts';
import type { PresenceChange } from '../server/presence.ts';
import { createRuleMachine, createRules, describeRule, validateSpec } from '../server/rules.ts';
import type { RuleAction, RuleSpec } from '../server/rules.ts';
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
    refuse(spec({ who: { type: 'list' } as never }), /seul « n'importe qui »/);
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
  return createRuleMachine(s, { cameras: ['C-01', 'C-02'], isArmed: (cameraId) => armed[cameraId] !== false });
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
