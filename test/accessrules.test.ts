// Fuseau horaire fixe pour tout le fichier (changement d'heure de la nuit du 25 octobre 2026) : AVANT toute date, restaure a la fin.
const SAVED_TZ = process.env.TZ;
process.env.TZ = 'Europe/Paris';

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { createAccessRuleMachine, describeAccessRule, isAccessSpec, validateAccessSpec } from '../server/accessrules.ts';
import type { AccessHolders, AccessRuleAction } from '../server/accessrules.ts';
import type { HoldersReader, PassDecision } from '../server/accessholderstypes.ts';
import { ACCESS_CALM_MS } from '../server/accessrulestypes.ts';
import type { AccessRuleSpec, PassageNote } from '../server/accessrulestypes.ts';
import { inSchedule } from '../server/arming.ts';
import type { Window } from '../server/arming.ts';
import { openDb } from '../server/db.ts';
import { createEngine, PsimError } from '../server/engine.ts';
import { createRules, describeRule, isAccessSpec as isAccessSpecFromRules } from '../server/rules.ts';
import type { RuleSpec } from '../server/rules.ts';
import { seedDemo } from '../server/seed.ts';

after(() => {
  if (SAVED_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = SAVED_TZ;
});

// Lundi 12 octobre 2026, minuit, heure LOCALE du serveur (les plages horaires et les textes se lisent en heure locale).
const T0 = new Date(2026, 9, 12, 0, 0, 0).getTime();
const S = 1000;
const MIN = 60 * S;
/** Instant local : jour du mois (octobre 2026), heure, minute, seconde. */
const local = (day: number, h: number, m = 0, s = 0): number => new Date(2026, 9, day, h, m, s).getTime();

const DOORS = new Set(['A-01', 'A-02', 'A-03']);
const NAMES: Record<string, string> = { 'A-01': 'Porte de service', 'A-02': 'Entree principale', 'A-03': 'Atelier' };
const doorName = (id: string): string => NAMES[id] ?? id;
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const NIGHT: Window[] = [{ days: ALL_DAYS, from: '22:00', to: '06:00' }];
const DAYTIME: Window[] = [{ days: [1, 2, 3, 4, 5], from: '08:00', to: '18:00' }];

// ---- Outils ---------------------------------------------------------------------------------------------------------------------

let seq = 0;
const pass = (at: number, over: Partial<PassageNote> = {}): PassageNote => ({
  id: ++seq,
  doorId: 'A-01',
  controllerId: 'CTL-1',
  at,
  receivedAt: at + 1000,
  direction: 'in',
  credential: '0012345',
  holderId: 7,
  holderRef: 'H7',
  method: 'badge',
  result: 'granted',
  reason: null,
  late: false,
  ...over,
});
const denied = (at: number, over: Partial<PassageNote> = {}): PassageNote => pass(at, { result: 'denied', reason: 'out_of_schedule', ...over });

const spec = (what: AccessRuleSpec['what'], over: Partial<AccessRuleSpec> = {}): AccessRuleSpec => ({
  kind: 'access',
  what,
  where: { allDoors: true },
  when: { type: 'always' },
  then: { severity: 'warning' },
  cooldownMinutes: 10,
  ...over,
});
const OFF: AccessRuleSpec['what'] = { type: 'off_hours', groupId: 1, groupName: 'Nuit' };
const SPREAD: AccessRuleSpec['what'] = { type: 'denied_spread', subject: 'same_badge', denials: 2, doors: 2, windowS: 60 };
const WATCH_BADGE: AccessRuleSpec['what'] = { type: 'badge_used', target: { by: 'badge', number: '0012345' } };
const WATCH_HOLDER: AccessRuleSpec['what'] = { type: 'badge_used', target: { by: 'holder', holderId: 7, label: 'Awa Koné' } };

/** Faux titulaires : groupes avec droits par porte, plages horaires reelles (`inSchedule`), jours feries. */
interface Right {
  doorId: string; // '*' : toutes les portes
  windows: Window[] | null; // null : tout le temps
  closedOnHolidays: boolean;
}
interface FakeConfig {
  groups: Record<number, { name: string; rights: Right[] }>;
  holders: { id: number; groups: number[]; state?: 'active' | 'suspended' | 'expired' }[];
  holidays?: string[]; // AAAA-MM-JJ
}
const pad = (n: number): string => String(n).padStart(2, '0');
function fakeHolders(cfg: FakeConfig): HoldersReader & { calls: number } {
  const holidays = new Set(cfg.holidays ?? []);
  const isHoliday = (at: number): boolean => {
    const d = new Date(at);
    return holidays.has(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
  };
  const concerns = (r: Right, doorId: string): boolean => r.doorId === '*' || r.doorId === doorId;
  const scheduled = (r: Right, at: number): boolean => r.windows === null || inSchedule(r.windows, at);
  const inForce = (r: Right, doorId: string, at: number): boolean => concerns(r, doorId) && scheduled(r, at) && !(r.closedOnHolidays && isHoliday(at));
  const out = {
    calls: 0,
    groupsOf: (holderId: number) => {
      const h = cfg.holders.find((x) => x.id === holderId);
      return h ? h.groups.map((id) => ({ id, name: cfg.groups[id].name })) : [];
    },
    holderOfBadge: () => null,
    canPass: (holderId: number, doorId: string, at: number = Date.now()): PassDecision => {
      out.calls++;
      const h = cfg.holders.find((x) => x.id === holderId);
      const no = (reason: PassDecision['reason']): PassDecision => ({ allowed: false, reason, groupId: null, scheduleId: null });
      if (!h) return no('unknown_holder');
      if (h.state === 'suspended') return no('suspended');
      if (h.state === 'expired') return no('expired');
      let reason: PassDecision['reason'] = 'no_right';
      for (const gid of h.groups) {
        for (const r of cfg.groups[gid].rights) {
          if (!concerns(r, doorId)) continue;
          if (inForce(r, doorId, at)) return { allowed: true, reason: 'ok', groupId: gid, scheduleId: 1 };
          if (scheduled(r, at) && r.closedOnHolidays && isHoliday(at)) reason = 'holiday';
          else if (reason !== 'holiday') reason = 'out_of_schedule';
        }
      }
      return no(reason);
    },
    groupsAllowedAt: (at: number, doorId?: string) =>
      Object.entries(cfg.groups)
        .map(([id, g]) => ({ id: Number(id), name: g.name, doorIds: g.rights.filter((r) => inForce(r, doorId ?? r.doorId, at)).map((r) => r.doorId) }))
        .filter((g) => g.doorIds.length > 0),
    isHoliday,
  };
  return out;
}

/**
 * Site d'essai : groupe 1 « Nuit » (toutes les portes de 22:00 a 06:00, ferme les jours feries), groupe 2 « Jour » (toutes les
 * portes en semaine de 08:00 a 18:00), groupe 3 « Astreinte » (porte A-02 a toute heure). Titulaires : 7 (Nuit), 8 (Nuit +
 * Astreinte), 9 (Nuit, suspendu), 10 (Jour), 11 (Nuit, expire).
 */
function site(holidays: string[] = ['2026-10-14']) {
  return fakeHolders({
    groups: {
      1: { name: 'Nuit', rights: [{ doorId: '*', windows: NIGHT, closedOnHolidays: true }] },
      2: { name: 'Jour', rights: [{ doorId: '*', windows: DAYTIME, closedOnHolidays: false }] },
      3: { name: 'Astreinte', rights: [{ doorId: 'A-02', windows: null, closedOnHolidays: false }] },
    },
    holders: [{ id: 7, groups: [1] }, { id: 8, groups: [1, 3] }, { id: 9, groups: [1], state: 'suspended' }, { id: 10, groups: [2] }, { id: 11, groups: [1], state: 'expired' }],
    holidays,
  });
}

/** `holders` : null = pas de lecture des titulaires (undefined prend la valeur par defaut). */
function machine(s: AccessRuleSpec, holders: AccessHolders | null = site(), scope: ReadonlySet<string> = DOORS) {
  return createAccessRuleMachine(s, { holders: holders ?? undefined, inScope: (id) => scope.has(id), doorName });
}

const brief = (actions: AccessRuleAction[]): string[] => actions.map((a) => (a.kind === 'clear' ? `clear@${(a.at - T0) / S}` : `${a.event}:${a.doorId}@${(a.at - T0) / S}`));
const triggers = (actions: AccessRuleAction[]) => actions.filter((a): a is Extract<AccessRuleAction, { kind: 'trigger' }> => a.kind === 'trigger');
const detailOf = (actions: AccessRuleAction[]): string => {
  const t = triggers(actions);
  assert.equal(t.length, 1, 'un declenchement attendu');
  return t[0].detail;
};

const refused = (fn: () => unknown, pattern: RegExp, label = ''): void =>
  assert.throws(fn, (e: unknown) => e instanceof PsimError && e.status === 400 && pattern.test(e.message), `devait etre refuse (400) : ${pattern} ${label}`);

// ---- 1. Validation ----------------------------------------------------------------------------------------------------------------

const VALID = (): Record<string, unknown> => ({
  kind: 'access',
  what: { type: 'off_hours', groupId: 1, groupName: 'Nuit' },
  where: { doors: ['A-01'] },
  when: { type: 'always' },
  then: { severity: 'warning' },
});
const ctx = { doorIds: DOORS as ReadonlySet<string> };
const check = (over: Record<string, unknown>) => validateAccessSpec({ ...VALID(), ...over }, ctx);

describe("regles d'acces : garde isAccessSpec", () => {
  it('seul `kind: access` (propre) designe une regle d\'acces ; une specification sans `kind` reste une regle de presence', () => {
    assert.equal(isAccessSpec(VALID()), true);
    assert.equal(isAccessSpecFromRules(VALID()), true, 'meme garde reexporte par rules.ts');
    assert.equal(isAccessSpec({ who: { type: 'anyone' }, where: { cameras: ['C-01'] } }), false);
    assert.equal(isAccessSpec({ ...VALID(), kind: 'presence' }), false);
    assert.equal(isAccessSpec(Object.create({ kind: 'access' })), false, 'propriete heritee ignoree');
    for (const v of [null, undefined, 'access', 3, [], [{ kind: 'access' }]]) assert.equal(isAccessSpec(v), false);
  });
});

describe("regles d'acces : validation de la specification", () => {
  it('une specification minimale est normalisee : valeurs par defaut, copie profonde, cles dans un ordre stable', () => {
    const out = check({});
    assert.deepEqual(out, {
      kind: 'access',
      what: { type: 'off_hours', groupId: 1, groupName: 'Nuit' },
      where: { doors: ['A-01'] },
      when: { type: 'always' },
      then: { severity: 'warning' },
      cooldownMinutes: 10,
    });
    assert.deepEqual(Object.keys(out), ['kind', 'what', 'where', 'when', 'then', 'cooldownMinutes']);
    const input = VALID();
    const normalized = validateAccessSpec(input, ctx);
    assert.notEqual(normalized.what, input.what, 'copie, pas la meme reference');
  });

  it('denied_spread : valeurs par defaut 2 refus / 2 portes / 60 s, « un meme badge » par defaut', () => {
    const out = check({ what: { type: 'denied_spread' }, where: { allDoors: true } });
    assert.deepEqual(out.what, { type: 'denied_spread', subject: 'same_badge', denials: 2, doors: 2, windowS: 60 });
    assert.deepEqual(check({ what: { type: 'denied_spread', subject: 'any_badge', denials: 5, doors: 3, windowS: 120 }, where: { allDoors: true } }).what, { type: 'denied_spread', subject: 'any_badge', denials: 5, doors: 3, windowS: 120 });
  });

  it('badge_used : par numero de badge ou par titulaire', () => {
    assert.deepEqual(check({ what: { type: 'badge_used', target: { by: 'badge', number: '0012345' } } }).what, { type: 'badge_used', target: { by: 'badge', number: '0012345' } });
    assert.deepEqual(check({ what: { type: 'badge_used', target: { by: 'holder', holderId: 7, label: '  Awa   Koné ' } } }).what, { type: 'badge_used', target: { by: 'holder', holderId: 7, label: 'Awa Koné' } });
  });

  it('refuse un objet inconnu, des champs inconnus a chaque niveau, et un `kind` autre que « access »', () => {
    refused(() => validateAccessSpec(null, ctx), /objet est attendu/);
    refused(() => validateAccessSpec([VALID()], ctx), /objet est attendu/);
    refused(() => validateAccessSpec('x', ctx), /objet est attendu/);
    refused(() => check({ extra: 1 }), /champ « extra » non reconnu/);
    refused(() => check({ kind: 'presence' }), /« kind » doit valoir « access »/);
    refused(() => check({ what: { type: 'off_hours', groupId: 1, groupName: 'Nuit', extra: 1 } }), /^Si : champ « extra » non reconnu/);
    refused(() => check({ what: { type: 'badge_used', target: { by: 'badge', number: '1', extra: 1 } } }), /^Qui : champ « extra » non reconnu/);
    refused(() => check({ what: { type: 'badge_used', target: { by: 'holder', holderId: 7, label: 'x', extra: 1 } } }), /^Qui : champ « extra » non reconnu/);
    refused(() => check({ what: { type: 'denied_spread', extra: 1 }, where: { allDoors: true } }), /^Si : champ « extra » non reconnu/);
    refused(() => check({ where: { doors: ['A-01'], extra: 1 } }), /^Ou : champ « extra » non reconnu/);
    refused(() => check({ when: { type: 'always', extra: 1 } }), /^Quand : champ « extra » non reconnu/);
    refused(() => check({ when: { type: 'windows', windows: [{ days: [1], from: '08:00', to: '09:00', extra: 1 }] } }), /^Quand : plage : champ « extra » non reconnu/);
    refused(() => check({ then: { severity: 'warning', extra: 1 } }), /^Alors : champ « extra » non reconnu/);
  });

  it("refuse __proto__ en propriete propre, et ignore les proprietes heritees (aucune pollution)", () => {
    const hostile = JSON.parse('{"kind":"access","what":{"type":"off_hours","groupId":1,"groupName":"Nuit"},"where":{"doors":["A-01"]},"when":{"type":"always"},"then":{"severity":"warning"},"__proto__":{"polluted":1}}');
    refused(() => validateAccessSpec(hostile, ctx), /champ « __proto__ » non reconnu/);
    refused(() => check({ what: JSON.parse('{"type":"off_hours","groupId":1,"groupName":"Nuit","__proto__":{"x":1}}') }), /champ « __proto__ » non reconnu/);
    refused(() => validateAccessSpec(Object.create(VALID()), ctx), /objet est attendu/);
    refused(() => check({ what: Object.create({ type: 'off_hours', groupId: 1, groupName: 'Nuit' }) }), /^Si : un objet est attendu/);
    refused(() => check({ where: Object.create({ doors: ['A-01'] }) }), /^Ou : un objet est attendu/);
    // une propriete heritee ne remplace pas une case manquante
    const inherited = Object.assign(Object.create({ then: { severity: 'warning' } }) as Record<string, unknown>, { ...VALID(), then: undefined });
    delete inherited.then;
    refused(() => validateAccessSpec(inherited, ctx), /objet est attendu/);
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
  });

  it('chaque case manquante est nommee', () => {
    for (const [key, label] of [['what', 'Si'], ['where', 'Ou'], ['when', 'Quand'], ['then', 'Alors']] as const) {
      const spec = VALID();
      delete spec[key];
      refused(() => validateAccessSpec(spec, ctx), new RegExp(`case « ${label} »`));
    }
  });

  it('Qui : groupe, titulaire et badge', () => {
    for (const bad of [0, -1, 1.5, '1', null, Number.NaN, 2 ** 31, undefined]) {
      refused(() => check({ what: { type: 'off_hours', groupId: bad, groupName: 'Nuit' } }), /^Qui : groupe/, String(bad));
      refused(() => check({ what: { type: 'badge_used', target: { by: 'holder', holderId: bad, label: 'x' } } }), /^Qui : titulaire/, String(bad));
    }
    for (const bad of ['', '   ', 'x'.repeat(81), 'a\u0000b', 'a‮b', 'a​b', 3, null, undefined]) {
      refused(() => check({ what: { type: 'off_hours', groupId: 1, groupName: bad } }), /^Qui : nom du groupe/, JSON.stringify(bad));
      refused(() => check({ what: { type: 'badge_used', target: { by: 'holder', holderId: 7, label: bad } } }), /^Qui : nom du titulaire/, JSON.stringify(bad));
    }
    for (const bad of ['', 'x'.repeat(33), 'a b', 'a\tb', 'a\u0000b', 'a‮b', 12345, null, undefined]) {
      refused(() => check({ what: { type: 'badge_used', target: { by: 'badge', number: bad } } }), /^Qui : badge surveille/, JSON.stringify(bad));
    }
    assert.equal(((check({ what: { type: 'badge_used', target: { by: 'badge', number: 'x'.repeat(32) } } }).what as { target: { number: string } }).target.number).length, 32);
    refused(() => check({ what: { type: 'badge_used', target: { by: 'autre' } } }), /^Qui : choisir un numéro de badge ou un titulaire/);
    refused(() => check({ what: { type: 'badge_used', target: 'x' } }), /^Qui : un objet est attendu/);
    refused(() => check({ what: { type: 'denied_spread', subject: 'autre' }, where: { allDoors: true } }), /^Qui : choisir « un même badge »/);
  });

  it('Si : type inconnu, bornes de denied_spread, doors <= denials', () => {
    refused(() => check({ what: { type: 'inconnu' } }), /^Si : choisir/);
    refused(() => check({ what: 'off_hours' }), /^Si : un objet est attendu/);
    const spread = (over: Record<string, unknown>) => check({ what: { type: 'denied_spread', ...over }, where: { allDoors: true } });
    for (const [key, bads] of [['denials', [1, 21, 0, -3, 2.5, '2', null, Number.NaN]], ['doors', [1, 11, 0, 2.5, '2', null]], ['windowS', [9, 3601, 0, -1, 10.5, '60', null]]] as const) {
      for (const bad of bads) refused(() => spread({ denials: 10, doors: 2, [key]: bad }), /^Si : /, `${key}=${String(bad)}`);
    }
    // bornes incluses
    assert.equal((spread({ denials: 2, doors: 2, windowS: 10 }).what as { windowS: number }).windowS, 10);
    assert.equal((spread({ denials: 20, doors: 10, windowS: 3600 }).what as { denials: number }).denials, 20);
    // doors <= denials
    refused(() => spread({ denials: 2, doors: 3 }), /^Si : le nombre de portes \(3\) ne peut pas dépasser le nombre de refus \(2\)/);
    refused(() => spread({ denials: 4, doors: 5 }), /nombre de portes/);
    assert.equal((spread({ denials: 3, doors: 3 }).what as { doors: number }).doors, 3, 'doors == denials est permis');
  });

  it('Ou : portes declarees, sans doublon ; « toutes les portes » exige au moins une porte declaree', () => {
    refused(() => check({ where: { doors: ['A-99'] } }), /^Ou : porte inconnue ou non déclarée « A-99 »/);
    refused(() => check({ where: { doors: [] } }), /^Ou : choisir au moins une porte/);
    refused(() => check({ where: { doors: 'A-01' } }), /^Ou : choisir au moins une porte/);
    refused(() => check({ where: { doors: [3] } }), /^Ou : nom de porte invalide/);
    refused(() => check({ where: { doors: [''] } }), /^Ou : nom de porte invalide/);
    refused(() => check({ where: { doors: Array.from({ length: 51 }, (_, i) => `A-${i}`) } }), /^Ou : 50 portes au plus/);
    refused(() => check({ where: {} }), /^Ou : choisir des portes OU toutes les portes/);
    refused(() => check({ where: { doors: ['A-01'], allDoors: true } }), /^Ou : choisir des portes OU toutes les portes/);
    refused(() => check({ where: { allDoors: false } }), /^Ou : « allDoors » vaut vrai/);
    refused(() => check({ where: { allDoors: 1 } }), /^Ou : « allDoors » vaut vrai/);
    assert.deepEqual(check({ where: { doors: ['A-02', 'A-01', 'A-02'] } }).where, { doors: ['A-02', 'A-01'] });
    assert.deepEqual(check({ where: { allDoors: true } }).where, { allDoors: true });
    refused(() => validateAccessSpec({ ...VALID(), where: { allDoors: true } }, { doorIds: new Set() }), /^Ou : Aucune porte n'est déclarée/);
    // refus sur N portes : il faut surveiller au moins N portes (sinon la regle ne pourrait jamais se declencher)
    refused(() => check({ what: { type: 'denied_spread', denials: 3, doors: 3, windowS: 60 }, where: { doors: ['A-01', 'A-02'] } }), /^Ou : .*au moins 3 portes/);
    assert.ok(check({ what: { type: 'denied_spread', denials: 3, doors: 3, windowS: 60 }, where: { doors: ['A-01', 'A-02', 'A-03'] } }));
  });

  it('Quand : toujours ou plages horaires (pas « zone armee »)', () => {
    assert.deepEqual(check({ when: { type: 'windows', windows: [{ days: [3, 1, 1], from: '22:00', to: '06:00' }] } }).when, { type: 'windows', windows: [{ days: [1, 3], from: '22:00', to: '06:00' }] });
    refused(() => check({ when: { type: 'armed' } }), /^Quand : choisir « toujours » ou des plages horaires/);
    refused(() => check({ when: { type: 'windows', windows: [] } }), /^Quand : au moins une plage/);
    refused(() => check({ when: { type: 'windows' } }), /^Quand : au moins une plage/);
    refused(() => check({ when: { type: 'windows', windows: ['x'] } }), /^Quand : plage : un objet est attendu/);
    refused(() => check({ when: { type: 'windows', windows: [{ days: [1], from: '25:00', to: '06:00' }] } }), /heures invalides/);
    refused(() => check({ when: { type: 'windows', windows: [{ days: [7], from: '22:00', to: '06:00' }] } }), /jours invalides/);
    refused(() => check({ when: { type: 'windows', windows: [{ days: [1], from: '22:00', to: '22:00' }] } }), /identiques/);
    refused(() => check({ when: {} }), /^Quand : choisir/);
  });

  it('Alors et repos : gravite valide, repos 0..1440 (defaut 10)', () => {
    for (const bad of ['', 'info', 3, null, undefined]) refused(() => check({ then: { severity: bad } }), /^Alors : la gravité/);
    refused(() => check({ then: null }), /^Alors : un objet est attendu/);
    assert.equal(check({ then: { severity: 'critical' } }).then.severity, 'critical');
    assert.equal(check({ cooldownMinutes: 0 }).cooldownMinutes, 0);
    assert.equal(check({ cooldownMinutes: 1440 }).cooldownMinutes, 1440);
    for (const bad of [-1, 1441, 1.5, '10', null, Number.NaN]) refused(() => check({ cooldownMinutes: bad }), /^Repos : /, String(bad));
  });
});

// ---- 2. Phrase en francais ------------------------------------------------------------------------------------------------------------

describe("regles d'acces : phrase en francais", () => {
  it('« badge hors horaires » : groupe, portes, a toute heure, repos', () => {
    const text = describeAccessRule(spec(OFF, { where: { doors: ['A-01'] } }), { doorName });
    assert.equal(text, 'Prévenir (avertissement) si un badge du groupe « Nuit » est utilisé hors de ses horaires à la porte « Porte de service », à toute heure ; ensuite, attendre 10 min avant de signaler à nouveau.');
    assert.match(describeAccessRule(spec(OFF, { where: { doors: ['A-01', 'A-02'] }, then: { severity: 'critical' } }), { doorName }), /^Prévenir \(alerte critique\) .* aux portes « Porte de service » ou « Entree principale »/);
    assert.match(describeAccessRule(spec(OFF), { doorName }), /à toutes les portes/);
    assert.match(describeAccessRule(spec(OFF, { cooldownMinutes: 0 }), { doorName }), /signaler à nouveau sans attendre\.$/);
    assert.match(describeAccessRule(spec(OFF, { when: { type: 'windows', windows: [{ days: [1, 2, 3, 4, 5], from: '22:00', to: '06:00' }] } }), { doorName }), /uniquement de 22:00 à 06:00 le lendemain, du lundi au vendredi/);
  });

  it('« badge surveille » : version normale (badge / titulaire), version anonyme sans nom ni numero', () => {
    const byBadge = spec(WATCH_BADGE);
    assert.match(describeAccessRule(byBadge, { doorName }), /si le badge « 0012345 » est utilisé/);
    const anon = describeAccessRule(byBadge, { doorName, anonymous: true });
    assert.doesNotMatch(anon, /0012345/);
    assert.match(anon, /si le badge surveillé est utilisé/);

    const byHolder = spec(WATCH_HOLDER);
    const normal = describeAccessRule(byHolder, { doorName });
    assert.match(normal, /Awa Koné/);
    assert.match(normal, /H7/);
    const anonHolder = describeAccessRule(byHolder, { doorName, anonymous: true });
    assert.doesNotMatch(anonHolder, /Awa|Koné/);
    assert.match(anonHolder, /si un badge du titulaire H7 est utilisé/);
  });

  it('« refus sur plusieurs portes » : nombres, duree lisible, portee', () => {
    const text = describeAccessRule(spec(SPREAD, { where: { doors: ['A-01', 'A-02'] } }), { doorName });
    assert.match(text, /si 2 refus ou plus sont enregistrés sur au moins 2 portes différentes en 60 s \(avec un même badge\)/);
    assert.match(text, /parmi les portes « Porte de service » ou « Entree principale »/);
    assert.match(describeAccessRule(spec({ ...SPREAD, windowS: 90 } as AccessRuleSpec['what']), { doorName }), /en 90 s/);
    assert.match(describeAccessRule(spec({ ...SPREAD, subject: 'any_badge', windowS: 120 } as AccessRuleSpec['what']), { doorName }), /en 2 min \(tous badges confondus\).*parmi toutes les portes/);
    assert.match(describeAccessRule(spec({ ...SPREAD, windowS: 150 } as AccessRuleSpec['what']), { doorName }), /en 2 min 30 s/);
    assert.match(describeAccessRule(spec({ ...SPREAD, windowS: 3600 } as AccessRuleSpec['what']), { doorName }), /en 1 h /);
  });

  it('rules.describeRule gere les deux sortes de regles', () => {
    const access = spec(OFF, { where: { doors: ['A-02'] } });
    assert.equal(describeRule(access, { cameraName: (id) => id, doorName }), describeAccessRule(access, { doorName }));
    assert.match(describeRule(access, { cameraName: (id) => id }), /porte « A-02 »/, 'sans doorName : l\'identifiant');
    const presence: RuleSpec = { who: { type: 'anyone' }, where: { cameras: ['C-01'] }, when: { type: 'always' }, trigger: { type: 'appears' }, then: { severity: 'critical' }, cooldownMinutes: 10 };
    assert.match(describeRule(presence, { cameraName: () => 'Portail' }), /^Prévenir \(alerte critique\) si quelqu'un apparaît devant la caméra « Portail »/);
  });
});

// ---- 3. Machine : badge hors horaires ---------------------------------------------------------------------------------------------------

describe("machine d'acces : « badge hors de ses horaires » (off_hours)", () => {
  /** Une machine neuve par passage : le passage declenche-t-il ? */
  const fires = (p: PassageNote, s: AccessRuleSpec = spec(OFF), holders: AccessHolders | null = site()): boolean => triggers(machine(s, holders).see(p)).length === 1;

  it("un titulaire du groupe, hors de ses horaires : declenche ; dans ses horaires : non", () => {
    assert.equal(fires(pass(local(12, 14, 0))), true, 'lundi 14:00, le groupe Nuit n\'a aucun droit a cette heure');
    assert.equal(fires(pass(local(12, 23, 30))), false, 'lundi 23:30 : dans la plage de nuit');
    assert.equal(fires(pass(local(13, 3, 0))), false, 'mardi 03:00 : encore la nuit de lundi');
  });

  it("le groupe doit etre celui de la regle : un titulaire d'un autre groupe ne declenche pas", () => {
    assert.equal(fires(pass(local(12, 23, 30), { holderId: 10 })), false, 'groupe Jour, hors de ses horaires mais pas du groupe Nuit');
    assert.equal(fires(pass(local(12, 23, 30), { holderId: 10 }), spec({ type: 'off_hours', groupId: 2, groupName: 'Jour' })), true, 'meme passage, regle sur le groupe Jour');
  });

  it("le resultat du controleur n'est pas regarde : un passage ACCEPTE par le controleur mais hors horaires du PSIM declenche", () => {
    assert.equal(fires(pass(local(12, 14, 0), { result: 'granted' })), true);
    assert.equal(fires(pass(local(12, 14, 0), { result: 'denied', reason: 'out_of_schedule' })), true, 'refuse aussi : hypothese prudente, tout passage compte');
  });

  it('jour ferie : la plage ferme les jours feries, le passage de nuit declenche', () => {
    // mercredi 14 octobre = ferie ; 23:30 serait dans la plage de nuit, mais le droit est ferme ce jour-la
    assert.equal(fires(pass(local(14, 23, 30))), true);
    assert.equal(fires(pass(local(15, 23, 30))), false, 'le lendemain, jour normal');
    const m = machine(spec(OFF));
    assert.match(detailOf(m.see(pass(local(14, 23, 30)))), /hors de ses horaires/);
    // la fausse canPass renvoie bien « holiday »
    assert.equal(site().canPass(7, 'A-01', local(14, 23, 30)).reason, 'holiday');
  });

  it('minuit : une plage 22:00-06:00 couvre 23:59:59 et 00:00:01, pas 21:59:59 ni 06:00:00', () => {
    const one: Window[] = [{ days: [1], from: '22:00', to: '06:00' }]; // lundi soir -> mardi matin
    const holders = fakeHolders({ groups: { 1: { name: 'Nuit', rights: [{ doorId: '*', windows: one, closedOnHolidays: false }] } }, holders: [{ id: 7, groups: [1] }] });
    assert.equal(fires(pass(local(12, 21, 59, 59)), spec(OFF), holders), true, '21:59:59');
    assert.equal(fires(pass(local(12, 22, 0, 0)), spec(OFF), holders), false, '22:00:00');
    assert.equal(fires(pass(local(12, 23, 59, 59)), spec(OFF), holders), false, 'lundi 23:59:59');
    assert.equal(fires(pass(local(13, 0, 0, 1)), spec(OFF), holders), false, 'mardi 00:00:01 (nuit de lundi)');
    assert.equal(fires(pass(local(13, 5, 59, 59)), spec(OFF), holders), false, 'mardi 05:59:59');
    assert.equal(fires(pass(local(13, 6, 0, 0)), spec(OFF), holders), true, 'mardi 06:00:00');
    assert.equal(fires(pass(local(13, 23, 59, 59)), spec(OFF), holders), true, 'mardi soir : la plage ne vaut que le lundi');
  });

  it("changement d'heure (nuit du 25 octobre 2026, Europe/Paris) : les plages et les textes suivent l'heure LOCALE", () => {
    assert.equal(new Date(Date.UTC(2026, 9, 25, 0, 30)).getHours(), 2, 'le fuseau de test est bien Europe/Paris (02:30 CEST)');
    const saturdayNight: Window[] = [{ days: [6], from: '22:00', to: '06:00' }];
    const holders = fakeHolders({ groups: { 1: { name: 'Nuit', rights: [{ doorId: '*', windows: saturdayNight, closedOnHolidays: false }] } }, holders: [{ id: 7, groups: [1] }] });
    const utc = (h: number, m: number, d = 25): number => Date.UTC(2026, 9, d, h, m, 0);
    assert.equal(fires(pass(utc(20, 30, 24)), spec(OFF), holders), false, 'samedi 22:30 CEST');
    assert.equal(fires(pass(utc(0, 30)), spec(OFF), holders), false, 'dimanche 02:30 CEST (premiere fois)');
    assert.equal(fires(pass(utc(1, 30)), spec(OFF), holders), false, 'dimanche 02:30 CET (seconde fois : l\'heure repasse a 02:00)');
    assert.equal(fires(pass(utc(4, 59)), spec(OFF), holders), false, 'dimanche 05:59 CET');
    assert.equal(fires(pass(utc(5, 0)), spec(OFF), holders), true, 'dimanche 06:00 CET : fin de la plage (la nuit a dure 9 h)');
    // le texte de l'incident donne l'heure locale du passage, y compris l'heure repetee (droit de nuit le vendredi seulement)
    const fridayNight: Window[] = [{ days: [5], from: '22:00', to: '06:00' }];
    const friday = fakeHolders({ groups: { 1: { name: 'Nuit', rights: [{ doorId: '*', windows: fridayNight, closedOnHolidays: false }] } }, holders: [{ id: 7, groups: [1] }] });
    const text = (at: number): string => detailOf(machine(spec(OFF), friday).see(pass(at, { doorId: 'A-01' })));
    assert.match(text(utc(0, 30)), / à 02:30,/);
    assert.match(text(utc(1, 30)), / à 02:30,/);
    assert.match(text(utc(5, 0)), / à 06:00,/);
  });

  it('un titulaire suspendu, expire ou inconnu, un badge inconnu ou un passage sans titulaire ne declenchent PAS (autre probleme)', () => {
    const t = local(12, 14, 0);
    assert.equal(fires(pass(t, { holderId: 9 })), false, 'suspendu');
    assert.equal(fires(pass(t, { holderId: 11 })), false, 'expire');
    assert.equal(fires(pass(t, { holderId: 999 })), false, 'titulaire inconnu du PSIM');
    assert.equal(fires(pass(t, { holderId: null, holderRef: null, credential: '99999' })), false, 'badge inconnu, passage sans titulaire');
    assert.equal(fires(pass(t, { holderId: null, credential: null, method: 'exit_button' })), false, 'bouton de sortie');
  });

  it('un titulaire dans deux groupes dont l\'autre a un droit en vigueur ne declenche pas', () => {
    // 8 : Nuit + Astreinte (A-02 a toute heure)
    assert.equal(fires(pass(local(12, 14, 0), { holderId: 8, doorId: 'A-02' })), false, 'Astreinte donne A-02 a 14:00');
    assert.equal(fires(pass(local(12, 14, 0), { holderId: 8, doorId: 'A-01' })), true, 'mais pas A-01');
    // recoupement explicite : meme si canPass refusait (stub incoherent), un groupe du titulaire autorise a cet instant l'emporte
    const stub: AccessHolders = {
      groupsOf: () => [{ id: 1, name: 'Nuit' }, { id: 3, name: 'Astreinte' }],
      canPass: () => ({ allowed: false, reason: 'out_of_schedule', groupId: 1, scheduleId: 1 }),
      groupsAllowedAt: () => [{ id: 3, name: 'Astreinte', doorIds: ['A-02'] }],
    };
    assert.equal(fires(pass(local(12, 14, 0)), spec(OFF), stub), false);
    const noOther: AccessHolders = { ...stub, groupsAllowedAt: () => [{ id: 2, name: 'Jour', doorIds: ['A-02'] }] };
    assert.equal(fires(pass(local(12, 14, 0)), spec(OFF), noOther), true, 'un groupe autorise que le titulaire n\'a pas ne compte pas');
  });

  it('un titulaire du groupe sans AUCUN droit sur la porte (no_right) ou deja autorise : pas de declenchement', () => {
    const holders = fakeHolders({
      groups: { 1: { name: 'Nuit', rights: [{ doorId: 'A-02', windows: NIGHT, closedOnHolidays: false }] } },
      holders: [{ id: 7, groups: [1] }],
    });
    assert.equal(fires(pass(local(12, 14, 0), { doorId: 'A-01' }), spec(OFF), holders), false, 'A-01 : aucun droit, ce n\'est pas un « hors horaires »');
    assert.equal(fires(pass(local(12, 14, 0), { doorId: 'A-02' }), spec(OFF), holders), true, 'A-02 : droit de nuit seulement');
  });

  it('sans lecture des titulaires (holders absent), ou si elle echoue : aucun declenchement et aucune exception', () => {
    assert.equal(fires(pass(local(12, 14, 0)), spec(OFF), null), false);
    const broken: AccessHolders = { groupsOf: () => { throw new Error('base illisible'); }, canPass: () => { throw new Error('x'); }, groupsAllowedAt: () => { throw new Error('x'); } };
    const originalError = console.error;
    console.error = () => {};
    try {
      assert.equal(fires(pass(local(12, 14, 0)), spec(OFF), broken), false);
    } finally {
      console.error = originalError;
    }
  });

  it("les portes hors de la portee sont ignorees, et la periode active (when) est testee a l'heure du passage", () => {
    const m = machine(spec(OFF, { where: { doors: ['A-02'] } }), site(), new Set(['A-02']));
    assert.deepEqual(m.see(pass(local(12, 14, 0), { doorId: 'A-01' })), []);
    assert.equal(triggers(m.see(pass(local(12, 14, 1), { doorId: 'A-02' }))).length, 1);

    const windows: AccessRuleSpec['when'] = { type: 'windows', windows: [{ days: [1], from: '12:00', to: '13:00' }] };
    assert.equal(fires(pass(local(12, 14, 0)), spec(OFF, { when: windows })), false, '14:00 hors de la plage de la regle');
    assert.equal(fires(pass(local(12, 12, 30)), spec(OFF, { when: windows })), true, '12:30 dans la plage (et hors des horaires du groupe)');
  });

  it("gravite : « warning » -> badge_offhours_noticed, « critical » -> badge_offhours (alarme)", () => {
    assert.equal(triggers(machine(spec(OFF)).see(pass(local(12, 14, 0))))[0].event, 'badge_offhours_noticed');
    assert.equal(triggers(machine(spec(OFF, { then: { severity: 'critical' } })).see(pass(local(12, 14, 0))))[0].event, 'badge_offhours');
  });
});

// ---- 4. Machine : badge surveille ----------------------------------------------------------------------------------------------------------

describe("machine d'acces : « badge utilise » (badge_used)", () => {
  it('par numero de badge : comparaison exacte du texte, accepte ou refuse', () => {
    const m = machine(spec(WATCH_BADGE, { cooldownMinutes: 0 }));
    assert.equal(triggers(m.see(pass(T0 + 10 * S, { credential: '0012345' }))).length, 1, 'accepte');
    m.release(T0 + 11 * S);
    assert.equal(triggers(m.see(denied(T0 + 20 * S, { credential: '0012345' }))).length, 1, 'refuse');
    for (const other of ['12345', '0012345 ', '00123456', '0012346', null]) {
      const n = machine(spec(WATCH_BADGE));
      assert.deepEqual(n.see(pass(T0 + 10 * S, { credential: other })), [], String(other));
    }
  });

  it('par titulaire : tous ses badges (le numero importe peu), jamais un passage sans titulaire', () => {
    assert.equal(triggers(machine(spec(WATCH_HOLDER)).see(pass(T0 + S, { holderId: 7, credential: 'A' }))).length, 1);
    assert.equal(triggers(machine(spec(WATCH_HOLDER)).see(pass(T0 + S, { holderId: 7, credential: 'B', result: 'denied', reason: 'expired' }))).length, 1);
    assert.deepEqual(machine(spec(WATCH_HOLDER)).see(pass(T0 + S, { holderId: 8 })), []);
    assert.deepEqual(machine(spec(WATCH_HOLDER)).see(pass(T0 + S, { holderId: null, holderRef: 'H7' })), []);
  });

  it("n'a pas besoin de la lecture des titulaires", () => {
    assert.equal(triggers(machine(spec(WATCH_BADGE), null).see(pass(T0 + S))).length, 1);
  });

  it("evenements : badge_watched_noticed (warning) / badge_watched (critical)", () => {
    assert.equal(triggers(machine(spec(WATCH_BADGE)).see(pass(T0)))[0].event, 'badge_watched_noticed');
    assert.equal(triggers(machine(spec(WATCH_BADGE, { then: { severity: 'critical' } })).see(pass(T0)))[0].event, 'badge_watched');
  });
});

// ---- 5. Machine : refus sur plusieurs portes -------------------------------------------------------------------------------------------------

describe("machine d'acces : « refus sur plusieurs portes » (denied_spread)", () => {
  const sp = (over: Partial<Extract<AccessRuleSpec['what'], { type: 'denied_spread' }>> = {}, rest: Partial<AccessRuleSpec> = {}): AccessRuleSpec => spec({ ...SPREAD, ...over } as AccessRuleSpec['what'], rest);
  const run = (s: AccessRuleSpec, items: PassageNote[]): AccessRuleAction[] => {
    const m = machine(s);
    return items.flatMap((p) => m.see(p));
  };

  it('2 refus sur 2 portes dans 60 s : declenche au second refus', () => {
    const out = run(sp(), [denied(T0 + 10 * S, { doorId: 'A-01' }), denied(T0 + 40 * S, { doorId: 'A-02' })]);
    assert.deepEqual(brief(out), ['denials_spread_noticed:A-02@40']);
  });

  it('un refus isole n\'est JAMAIS une alarme, meme repete sur la meme porte', () => {
    assert.deepEqual(run(sp(), [denied(T0)]), []);
    assert.deepEqual(run(sp(), [denied(T0), denied(T0 + 10 * S), denied(T0 + 20 * S), denied(T0 + 30 * S)]), [], 'meme porte : jamais deux portes');
  });

  it('2 refus sur 2 portes mais a plus de 60 s : non ; a 60 s exactement : oui (bornes incluses) ; a 60,001 s : non', () => {
    assert.deepEqual(run(sp(), [denied(T0, { doorId: 'A-01' }), denied(T0 + 61 * S, { doorId: 'A-02' })]), []);
    assert.deepEqual(brief(run(sp(), [denied(T0, { doorId: 'A-01' }), denied(T0 + 60 * S, { doorId: 'A-02' })])), ['denials_spread_noticed:A-02@60']);
    assert.deepEqual(run(sp(), [denied(T0, { doorId: 'A-01' }), denied(T0 + 60 * S + 1, { doorId: 'A-02' })]), []);
  });

  it('la fenetre glisse : un vieux refus sort, les deux plus recents suffisent', () => {
    // A@0, A@70, B@100 : [70, 130] contient A@70 et B@100
    assert.deepEqual(brief(run(sp(), [denied(T0, { doorId: 'A-01' }), denied(T0 + 70 * S, { doorId: 'A-01' }), denied(T0 + 100 * S, { doorId: 'A-02' })])), ['denials_spread_noticed:A-02@100']);
    // A@0, B@100 : trop loin
    assert.deepEqual(run(sp(), [denied(T0, { doorId: 'A-01' }), denied(T0 + 100 * S, { doorId: 'A-02' })]), []);
  });

  it('badges differents : « un meme badge » ne declenche pas, « tous badges confondus » oui', () => {
    const items = [denied(T0 + 10 * S, { doorId: 'A-01', credential: '111', holderId: 1 }), denied(T0 + 20 * S, { doorId: 'A-02', credential: '222', holderId: 2 })];
    assert.deepEqual(run(sp({ subject: 'same_badge' }), items), []);
    assert.deepEqual(brief(run(sp({ subject: 'any_badge' }), items)), ['denials_spread_noticed:A-02@20']);
  });

  it('« un meme badge » : memes numeros declenchent ; a defaut de numero, la reference du titulaire ; sans l\'un ni l\'autre, hors mode', () => {
    const same = [denied(T0 + 10 * S, { doorId: 'A-01', credential: '111' }), denied(T0 + 20 * S, { doorId: 'A-02', credential: '111' })];
    assert.equal(triggers(run(sp(), same)).length, 1);
    const byRef = [denied(T0 + 10 * S, { doorId: 'A-01', credential: null, holderRef: 'H7' }), denied(T0 + 20 * S, { doorId: 'A-02', credential: null, holderRef: 'H7' })];
    assert.equal(triggers(run(sp(), byRef)).length, 1);
    const none = [denied(T0 + 10 * S, { doorId: 'A-01', credential: null, holderRef: null, holderId: null }), denied(T0 + 20 * S, { doorId: 'A-02', credential: null, holderRef: null, holderId: null })];
    assert.deepEqual(run(sp(), none), [], 'same_badge : sans numero ni reference, le passage n\'entre pas dans ce mode');
    assert.equal(triggers(run(sp({ subject: 'any_badge' }), none)).length, 1, 'any_badge : il compte');
  });

  it('3 refus sur 3 portes parametres : 2 refus sur 2 portes ne suffisent pas, 3 refus sur 2 portes non plus', () => {
    const three = sp({ denials: 3, doors: 3 });
    assert.deepEqual(run(three, [denied(T0, { doorId: 'A-01' }), denied(T0 + 10 * S, { doorId: 'A-02' })]), []);
    assert.deepEqual(run(three, [denied(T0, { doorId: 'A-01' }), denied(T0 + 10 * S, { doorId: 'A-02' }), denied(T0 + 20 * S, { doorId: 'A-01' })]), [], '3 refus mais 2 portes');
    assert.deepEqual(brief(run(three, [denied(T0, { doorId: 'A-01' }), denied(T0 + 10 * S, { doorId: 'A-02' }), denied(T0 + 20 * S, { doorId: 'A-03' })])), ['denials_spread_noticed:A-03@20']);
    // 3 refus, 2 portes distinctes suffisent
    const lax = sp({ denials: 3, doors: 2 });
    assert.equal(triggers(run(lax, [denied(T0, { doorId: 'A-01' }), denied(T0 + S, { doorId: 'A-01' }), denied(T0 + 2 * S, { doorId: 'A-02' })])).length, 1);
  });

  it('les passages ACCEPTES et ceux des portes hors portee ne comptent pas', () => {
    assert.deepEqual(run(sp(), [denied(T0, { doorId: 'A-01' }), pass(T0 + 10 * S, { doorId: 'A-02' })]), []);
    const m = createAccessRuleMachine(sp({}, { where: { doors: ['A-01', 'A-02'] } }), { holders: site(), inScope: (id) => id !== 'A-03', doorName });
    assert.deepEqual([...m.see(denied(T0, { doorId: 'A-01' })), ...m.see(denied(T0 + 10 * S, { doorId: 'A-03' }))], []);
  });

  it('passages recus en differe ou dans le desordre : evalues avec leur propre heure, texte « passage reçu en différé »', () => {
    const m = machine(sp());
    assert.deepEqual(m.see(denied(T0 + 100 * S, { doorId: 'A-01' })), []);
    const out = m.see(denied(T0 + 70 * S, { doorId: 'A-02', late: true })); // plus ancien, arrive apres : 30 s d'ecart
    assert.equal(triggers(out).length, 1);
    assert.equal(triggers(out)[0].at, T0 + 70 * S, 'heure du passage');
    assert.match(triggers(out)[0].detail, /passage reçu en différé/);
    // trop ancien pour la fenetre : rien
    const m2 = machine(sp());
    m2.see(denied(T0 + 200 * S, { doorId: 'A-01' }));
    assert.deepEqual(m2.see(denied(T0 + 10 * S, { doorId: 'A-02', late: true })), []);
    // l'ordre d'arrivee ne change pas le resultat quand les deux sont dans la fenetre
    const a = machine(sp());
    const b = machine(sp());
    const x = denied(T0 + 10 * S, { doorId: 'A-01' });
    const y = denied(T0 + 50 * S, { doorId: 'A-02' });
    assert.equal(triggers([...a.see(x), ...a.see(y)]).length, 1);
    assert.equal(triggers([...b.see(y), ...b.see(x)]).length, 1);
  });

  it('prolongation : un refus qui complete encore une fenetre prolonge ; un refus isole ne prolonge pas', () => {
    const m = machine(sp());
    m.see(denied(T0, { doorId: 'A-01' }));
    assert.equal(triggers(m.see(denied(T0 + 10 * S, { doorId: 'A-02' }))).length, 1);
    assert.deepEqual(m.see(denied(T0 + 40 * S, { doorId: 'A-01' })), [], 'prolonge (pas un nouveau declenchement)');
    assert.equal(m.nextWake(), T0 + 100 * S, 'retour au calme 60 s apres le dernier refus qui correspond');
    // un refus tres tardif, isole de tout autre : ne prolonge rien
    const t = machine(sp());
    t.see(denied(T0, { doorId: 'A-01' }));
    t.see(denied(T0 + 10 * S, { doorId: 'A-02' }));
    assert.deepEqual(brief(t.tick(T0 + 70 * S)), ['clear@70']);
  });

  it('les refus hors periode active ou pendant le repos restent dans la fenetre (mais ne declenchent que dans la periode)', () => {
    const windows: AccessRuleSpec['when'] = { type: 'windows', windows: [{ days: [1], from: '12:00', to: '13:00' }] };
    const s = sp({}, { when: windows });
    const m = machine(s);
    assert.deepEqual(m.see(denied(local(12, 11, 59, 30), { doorId: 'A-01' })), []);
    assert.deepEqual(m.see(denied(local(12, 11, 59, 50), { doorId: 'A-02' })), [], 'hors plage : pas de declenchement');
    assert.equal(triggers(m.see(denied(local(12, 12, 0, 10), { doorId: 'A-03' }))).length, 1, 'dans la plage : la fenetre contient deja les refus precedents');
  });

  it('evenements : denials_spread_noticed (warning) / denials_spread (critical)', () => {
    const items = [denied(T0, { doorId: 'A-01' }), denied(T0 + S, { doorId: 'A-02' })];
    assert.equal(triggers(run(sp(), items))[0].event, 'denials_spread_noticed');
    assert.equal(triggers(run(sp({}, { then: { severity: 'critical' } }), items))[0].event, 'denials_spread');
  });

  it("beaucoup de badges differents : la memoire reste bornee (pas d'accumulation sans fin)", () => {
    const m = machine(sp());
    for (let i = 0; i < 3000; i++) m.see(denied(T0 + i * 100, { doorId: 'A-01', credential: `B${i}` }));
    assert.deepEqual(m.see(denied(T0 + 400 * S, { doorId: 'A-02', credential: 'B0' })), [], 'les anciens badges ont ete oublies, aucun faux declenchement');
  });
});

// ---- 6. Machine : retour au calme, repos, desordre, minuteries --------------------------------------------------------------------------

describe("machine d'acces : retour au calme, repos, passages en desordre, minuteries", () => {
  const watch = (over: Partial<AccessRuleSpec> = {}) => machine(spec(WATCH_BADGE, over));

  it('retour au calme a l\'instant EXACT dernier passage + 60 s, puis repos', () => {
    const m = watch();
    assert.deepEqual(brief(m.see(pass(T0 + 10 * S))), ['badge_watched_noticed:A-01@10']);
    assert.deepEqual(brief(m.see(pass(T0 + 40 * S))), [], 'prolonge');
    assert.equal(m.nextWake(), T0 + 40 * S + ACCESS_CALM_MS);
    assert.deepEqual(m.tick(T0 + 99 * S), [], 'encore 1 s');
    assert.equal(m.isTriggered(), true);
    assert.deepEqual(brief(m.tick(T0 + 100 * S)), ['clear@100'], 'a 60 s pile');
    assert.equal(m.isTriggered(), false);
    assert.equal(m.nextWake(), null);
  });

  it("le `clear` garde son instant exact meme si le tick arrive bien plus tard", () => {
    const m = watch();
    m.see(pass(T0 + 10 * S));
    assert.deepEqual(brief(m.tick(T0 + 3600 * S)), ['clear@70']);
  });

  it('repos : aucun declenchement pendant `cooldownMinutes` apres le retour au calme, puis la regle repart', () => {
    const m = watch({ cooldownMinutes: 10 });
    m.see(pass(T0));
    assert.deepEqual(brief(m.tick(T0 + 60 * S)), ['clear@60']);
    const restEnd = T0 + 60 * S + 10 * MIN;
    assert.deepEqual(m.see(pass(restEnd - 1)), [], 'a 1 ms de la fin du repos');
    assert.deepEqual(brief(m.see(pass(restEnd))), [`badge_watched_noticed:A-01@${(restEnd - T0) / S}`], 'repos termine');
  });

  it("un passage ignore pendant le repos ne prolonge pas le repos", () => {
    const m = watch({ cooldownMinutes: 10 });
    m.see(pass(T0));
    m.tick(T0 + 60 * S);
    m.see(pass(T0 + 5 * MIN)); // ignore
    assert.equal(triggers(m.see(pass(T0 + 60 * S + 10 * MIN))).length, 1);
  });

  it('repos nul : un passage a l\'instant du retour au calme declenche aussitot (le clear passe avant)', () => {
    const m = watch({ cooldownMinutes: 0 });
    m.see(pass(T0));
    assert.deepEqual(brief(m.see(pass(T0 + 60 * S))), ['clear@60', 'badge_watched_noticed:A-01@60']);
  });

  it('release : clear immediat sans repos ; sans declenchement, rien', () => {
    const m = watch();
    assert.deepEqual(m.release(T0), []);
    m.see(pass(T0 + S));
    assert.deepEqual(brief(m.release(T0 + 5 * S)), ['clear@5']);
    assert.equal(m.isTriggered(), false);
    assert.equal(triggers(m.see(pass(T0 + 6 * S))).length, 1, 'aucun repos apres un arret force');
  });

  it("l'horloge ne recule jamais : tick dans le passe, passage plus ancien que l'horloge", () => {
    const m = watch();
    m.see(pass(T0 + 100 * S));
    assert.deepEqual(m.tick(T0 + 10 * S), [], 'tick dans le passe : rien');
    assert.equal(m.nextWake(), T0 + 160 * S);
    // passage en differe plus ancien : prolonge a partir de l'horloge (100 s), jamais plus tot
    assert.deepEqual(m.see(pass(T0 + 50 * S, { late: true })), []);
    assert.equal(m.nextWake(), T0 + 160 * S, 'le retour au calme ne recule pas');
  });

  it("passage en differe sur une machine au repos : declenche avec SON heure dans le texte, retour au calme compte depuis maintenant", () => {
    const m = watch();
    m.tick(T0 + 3600 * S); // l'horloge est a 1 h
    const out = m.see(pass(local(12, 0, 5, 0), { late: true })); // passage de 00:05
    assert.equal(triggers(out).length, 1);
    assert.equal(triggers(out)[0].at, local(12, 0, 5, 0));
    assert.match(triggers(out)[0].detail, / à 00:05/);
    assert.match(triggers(out)[0].detail, /\(passage reçu en différé\)/);
    assert.equal(m.nextWake(), T0 + 3600 * S + ACCESS_CALM_MS);
    assert.deepEqual(brief(m.tick(T0 + 3600 * S + ACCESS_CALM_MS)), [`clear@${3600 + 60}`]);
  });

  it("la periode active se juge a l'heure du passage, pas a celle de l'horloge", () => {
    const windows: AccessRuleSpec['when'] = { type: 'windows', windows: [{ days: [1], from: '12:00', to: '13:00' }] };
    const m = watch({ when: windows });
    m.tick(local(12, 20, 0)); // horloge a 20:00, hors plage
    assert.equal(triggers(m.see(pass(local(12, 12, 30), { late: true }))).length, 1, 'passage de 12:30 recu a 20:00 : dans la plage');
    const n = watch({ when: windows });
    n.tick(local(12, 12, 30));
    assert.deepEqual(n.see(pass(local(12, 20, 0))), [], 'passage de 20:00 : hors plage');
  });

  it("une fois declenchee, la regle reste declenchee meme si la periode active se termine (jusqu'au retour au calme)", () => {
    const windows: AccessRuleSpec['when'] = { type: 'windows', windows: [{ days: [1], from: '12:00', to: '13:00' }] };
    const m = watch({ when: windows });
    assert.equal(triggers(m.see(pass(local(12, 12, 59, 30)))).length, 1);
    assert.deepEqual(m.see(pass(local(12, 13, 0, 20))), [], 'prolonge meme hors plage');
    assert.deepEqual(brief(m.tick(local(12, 13, 1, 20))).length, 1);
  });

  it('un tick par seconde et des sauts de nextWake donnent exactement les memes declenchements (scenarios aleatoires, 3 types)', () => {
    const rng = (seed: number) => () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const kinds: AccessRuleSpec[] = [
      spec(WATCH_BADGE, { cooldownMinutes: 2 }),
      spec(OFF, { cooldownMinutes: 0 }),
      spec({ ...SPREAD, windowS: 30 } as AccessRuleSpec['what'], { cooldownMinutes: 1, then: { severity: 'critical' } }),
      spec({ ...SPREAD, subject: 'any_badge' } as AccessRuleSpec['what'], { cooldownMinutes: 3 }),
    ];
    let total = 0;
    for (let seed = 1; seed <= 25; seed++) {
      const r = rng(seed);
      const doors = ['A-01', 'A-02', 'A-03'];
      const items: PassageNote[] = [];
      let sec = 0;
      for (let i = 0; i < 40; i++) {
        sec += Math.floor(r() * 50);
        const doorId = doors[Math.floor(r() * 3)];
        const base = local(12, 13, 0, 0) + sec * S;
        const ok = r() < 0.4;
        items.push(ok ? pass(base, { doorId, credential: r() < 0.5 ? '0012345' : '777' }) : denied(base, { doorId, credential: r() < 0.5 ? '0012345' : '777' }));
      }
      const end = local(12, 13, 0, 0) + (sec + 3600) * S;
      for (const [k, s] of kinds.entries()) {
        const dense = machine(s);
        const sparse = machine(s);
        const denseOut: AccessRuleAction[] = [];
        let j = 0;
        const start = local(12, 13, 0, 0);
        for (let t = start; t <= end; t += S) {
          while (j < items.length && items[j].at <= t) denseOut.push(...dense.see(items[j++]));
          denseOut.push(...dense.tick(t));
        }
        const sparseOut: AccessRuleAction[] = [];
        for (const p of items) sparseOut.push(...sparse.see(p));
        sparseOut.push(...sparse.tick(end));
        const key = (a: AccessRuleAction[]) => a.map((x) => (x.kind === 'clear' ? `clear@${x.at}` : `${x.event}:${x.doorId}@${x.at}`));
        assert.deepEqual(key(sparseOut), key(denseOut), `graine ${seed}, regle ${k}`);
        total += denseOut.length;
      }
    }
    assert.ok(total > 100, `les scenarios declenchent bien (${total} actions)`);
  });
});

// ---- 7. Texte de l'incident --------------------------------------------------------------------------------------------------------------

describe("machine d'acces : texte de l'incident (SMS, courriel) : porte, heure, jamais de nom ni de numero de badge", () => {
  const SECRET_BADGE = '0012345';
  const forbidden = (text: string): void => {
    assert.ok(!text.includes(SECRET_BADGE), `numero de badge dans le texte : ${text}`);
    assert.ok(!text.includes('12345'), `fragment de badge dans le texte : ${text}`);
    assert.doesNotMatch(text, /Awa|Koné|KONE|KONAN/i, `nom de titulaire dans le texte : ${text}`);
  };

  it('badge hors horaires : nomme la porte, l\'heure locale et H<id>, jamais le badge', () => {
    const text = detailOf(machine(spec(OFF)).see(pass(local(12, 14, 7), { doorId: 'A-02' })));
    assert.equal(text, 'Badge du titulaire H7 (groupe « Nuit ») utilisé hors de ses horaires à la porte « Entree principale » à 14:07, passage accepté.');
    forbidden(text);
    assert.match(detailOf(machine(spec(OFF)).see(pass(local(12, 14, 7), { result: 'denied' }))), /passage refusé\.$/);
    assert.match(detailOf(machine(spec(OFF)).see(pass(local(12, 9, 5), { late: true }))), / à 09:05, passage accepté \(passage reçu en différé\)\.$/);
  });

  it('le nom du groupe est celui d\'aujourd\'hui (renomme depuis), pas celui recopie dans la regle', () => {
    assert.match(detailOf(machine(spec({ type: 'off_hours', groupId: 1, groupName: 'Ancien nom' })).see(pass(local(12, 14, 0)))), /\(groupe « Nuit »\)/);
  });

  it('badge surveille : par badge (titulaire connu ou non), par titulaire', () => {
    const known = detailOf(machine(spec(WATCH_BADGE)).see(pass(local(12, 8, 12), { doorId: 'A-03' })));
    assert.equal(known, 'Badge surveillé utilisé à la porte « Atelier » à 08:12 : titulaire H7, passage accepté.');
    forbidden(known);
    const unattached = detailOf(machine(spec(WATCH_BADGE)).see(denied(local(12, 8, 12), { holderId: null, holderRef: null })));
    assert.equal(unattached, 'Badge surveillé utilisé à la porte « Porte de service » à 08:12 : badge non rattaché à un titulaire, passage refusé.');
    forbidden(unattached);
    const byHolder = detailOf(machine(spec(WATCH_HOLDER)).see(pass(local(12, 23, 59), { credential: SECRET_BADGE })));
    assert.match(byHolder, /titulaire H7/);
    forbidden(byHolder);
  });

  it('refus sur plusieurs portes : nombre, portes, heure du dernier refus, H<id> (un meme badge)', () => {
    const m = machine(spec(SPREAD));
    m.see(denied(local(12, 14, 3, 0), { doorId: 'A-01' }));
    const text = detailOf(m.see(denied(local(12, 14, 3, 20), { doorId: 'A-02' })));
    assert.equal(text, '2 refus sur 2 portes différentes en 60 s au plus, dernier refus à 14:03 ; titulaire H7 ; portes : « Porte de service », « Entree principale ».');
    forbidden(text);
    const anyBadge = machine(spec({ ...SPREAD, subject: 'any_badge' } as AccessRuleSpec['what']));
    anyBadge.see(denied(local(12, 14, 3, 0), { doorId: 'A-01' }));
    const text2 = detailOf(anyBadge.see(denied(local(12, 14, 3, 20), { doorId: 'A-02', holderId: null, holderRef: null, credential: '999999' })));
    assert.doesNotMatch(text2, /titulaire|999999/, 'tous badges confondus : aucun titulaire ni numero');
    const noHolder = machine(spec(SPREAD));
    noHolder.see(denied(local(12, 14, 3, 0), { doorId: 'A-01', holderId: null }));
    assert.match(detailOf(noHolder.see(denied(local(12, 14, 3, 20), { doorId: 'A-02', holderId: null }))), /badge non rattaché à un titulaire/);
  });

  it("le texte tient dans les 300 caracteres d'un `detail` meme avec dix portes aux noms longs, et reste lisible (porte et heure presentes)", () => {
    const longNames = (id: string): string => `Porte tres longue numero ${id} du batiment principal et annexes`;
    const m = createAccessRuleMachine(spec({ type: 'denied_spread', subject: 'any_badge', denials: 10, doors: 10, windowS: 600 }), { holders: site(), inScope: () => true, doorName: longNames });
    let out: AccessRuleAction[] = [];
    for (let i = 0; i < 10; i++) out = m.see(denied(local(12, 14, 3, i), { doorId: `D-${i}` }));
    const text = detailOf(out);
    assert.ok(text.length <= 300, `${text.length} caracteres`);
    assert.match(text, /^10 refus sur 10 portes différentes/);
    assert.match(text, /14:03/);
    assert.match(text, /Porte tres longue/);
  });
});

// ---- 8. Moteur reel : createRules ------------------------------------------------------------------------------------------------------

function fakePassages() {
  const listeners = new Set<(p: PassageNote) => void>();
  const log: PassageNote[] = [];
  return {
    emit(p: PassageNote) {
      log.push(p);
      for (const fn of [...listeners]) fn(p);
    },
    /** Historique ajoute sans prevenir personne (essai sur le passe). */
    seed(items: PassageNote[]) {
      log.push(...items);
    },
    subscribe(fn: (p: PassageNote) => void) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    history(from: number, to: number, doorIds?: readonly string[]): PassageNote[] {
      return log
        .filter((p) => p.at >= from && p.at <= to && (!doorIds || doorIds.includes(p.doorId)))
        .map((p, i) => ({ p, i }))
        .sort((a, b) => a.p.at - b.p.at || a.i - b.i)
        .map((x) => x.p);
    },
    listenerCount: () => listeners.size,
    log,
  };
}

/** Lundi 12 octobre 2026, 14:00 locale : hors des horaires du groupe Nuit. */
const T1 = local(12, 14, 0, 0);

interface SetupOptions {
  withPassages?: boolean;
  withHolders?: boolean;
}

function setup(opts: SetupOptions = {}) {
  const db = openDb(':memory:');
  seedDemo(db, mkdtempSync(join(tmpdir(), 'psim-')), join(import.meta.dirname, '..', 'seed'));
  let clock = T1;
  const engine = createEngine(db, () => {}, () => clock);
  // Portes : A-01 (seed, zone Entrepot, camera C-04), A-02 (Accueil, C-01 + C-02), A-03 (Atelier, C-05 + C-04).
  engine.createDevice('admin', { id: 'A-02', kind: 'detector', name: 'Entree principale', zone: 'Accueil', category: 'access' });
  engine.createDevice('admin', { id: 'A-03', kind: 'detector', name: 'Porte atelier', zone: 'Atelier', category: 'access' });
  engine.setLinks('admin', 'A-02', ['C-02', 'C-01']);
  engine.setLinks('admin', 'A-03', ['C-05', 'C-04']);
  db.prepare("INSERT INTO access_controller (id, name, brand, created_at, created_by, updated_at, updated_by) VALUES ('CTL-1', 'Controleur', 'dahua', 0, 'admin', 0, 'admin')").run();
  const declare = (id: string, no: number) => db.prepare('INSERT INTO access_door (detector_id, controller_id, door_no) VALUES (?, ?, ?)').run(id, 'CTL-1', no);
  declare('A-01', 1);
  declare('A-02', 2);
  declare('A-03', 3);

  const passages = fakePassages();
  const holders = site();
  const sent: { sec: number; deviceId: string; payload: Record<string, unknown> }[] = [];
  const spied = {
    handleDetectorMessage: (deviceId: string, payload: unknown) => {
      sent.push({ sec: (clock - T1) / S, deviceId, payload: payload as Record<string, unknown> });
      engine.handleDetectorMessage(deviceId, payload);
    },
    audit: engine.audit,
    getDevice: engine.getDevice,
    createDevice: engine.createDevice,
    updateDevice: engine.updateDevice,
    deleteDevice: engine.deleteDevice,
    setLinks: engine.setLinks,
    getSnapshot: engine.getSnapshot,
  };
  const presence = {
    subscribe: () => () => {},
    history: () => [],
    current: () => ({}),
  };
  const build = () =>
    createRules({
      db,
      engine: spied,
      presence,
      passages: opts.withPassages === false ? undefined : passages,
      holders: opts.withHolders === false ? undefined : holders,
      isArmed: () => true,
      now: () => clock,
    });
  const h = {
    db,
    engine,
    passages,
    holders,
    sent,
    rules: build(),
    restart() {
      h.rules.close();
      h.rules = build();
      return h.rules;
    },
    set: (at: number) => void (clock = at),
    /** Tick toutes les secondes jusqu'a `at`. */
    runTo(at: number) {
      while (clock < at) {
        clock = Math.min(at, clock + S);
        h.rules.tick();
      }
    },
    status: (id: string) => engine.getDevice(id)?.status,
    incidents: (deviceId: string) => engine.getSnapshot().incidents.filter((i) => i.detectorId === deviceId),
    audit: (prefix = 'rule_') => engine.listAudit(500).filter((a) => a.action.startsWith(prefix)).reverse(),
    triggers: () => sent.filter((m) => m.payload.event !== 'clear'),
  };
  return h;
}

type H = ReturnType<typeof setup>;
const create = (h: H, s: AccessRuleSpec, name = 'Surveillance', extra: { sourceText?: string | null; enabled?: boolean } = {}) => h.rules.create('admin', { name, spec: s, ...extra });

describe("regles d'acces : detecteur virtuel", () => {
  it('chaque regle a son detecteur R-<id> : categorie acces, non supervise, zone / etage / position de la 1re porte, liens = cameras des portes', () => {
    const h = setup();
    const rule = create(h, spec(OFF), 'Nuit hors horaires');
    assert.equal(rule.kind, 'access');
    assert.equal(rule.deviceId, 'R-1');
    assert.equal(rule.needsReview, false);
    assert.equal(isAccessSpec(rule.spec), true);
    const device = h.engine.getDevice('R-1')!;
    const first = h.engine.getDevice('A-01')!;
    assert.equal(device.kind, 'detector');
    assert.equal(device.name, 'Nuit hors horaires');
    assert.equal(device.category, 'access');
    assert.equal(device.heartbeatS, 0);
    assert.equal(device.zone, first.zone);
    assert.equal(device.floorId, first.floorId);
    assert.equal(device.x, first.x);
    assert.equal(device.y, first.y);
    assert.equal(device.status, 'normal');
    assert.deepEqual(h.engine.getSnapshot().links['R-1'], ['C-01', 'C-02', 'C-04', 'C-05'], 'union triee des cameras des trois portes');
  });

  it('une regle sur une liste de portes : 1re porte par identifiant (pas par ordre de saisie), liens = ses cameras seulement', () => {
    const h = setup();
    const rule = create(h, spec(OFF, { where: { doors: ['A-03', 'A-02'] } }), 'Deux portes');
    const device = h.engine.getDevice(rule.deviceId)!;
    assert.equal(device.zone, 'Accueil', 'A-02 vient avant A-03');
    assert.deepEqual(h.engine.getSnapshot().links[rule.deviceId], ['C-01', 'C-02', 'C-04', 'C-05']);
    const one = create(h, spec(OFF, { where: { doors: ['A-02'] } }), 'Une porte');
    assert.deepEqual(h.engine.getSnapshot().links[one.deviceId], ['C-01', 'C-02']);
  });

  it('porte sans camera liee : detecteur cree sans lien', () => {
    const h = setup();
    h.engine.setLinks('admin', 'A-03', []);
    const rule = create(h, spec(OFF, { where: { doors: ['A-03'] } }));
    assert.deepEqual(h.engine.getSnapshot().links[rule.deviceId] ?? [], []);
    assert.equal(h.engine.getDevice(rule.deviceId)!.zone, 'Atelier');
  });

  it("le nom suit la regle ; mise a jour : zone et liens suivent la nouvelle portee", () => {
    const h = setup();
    const rule = create(h, spec(OFF, { where: { doors: ['A-01'] } }));
    assert.deepEqual(h.engine.getSnapshot().links[rule.deviceId], ['C-04']);
    h.rules.update('admin', rule.id, { name: 'Autre nom' });
    assert.equal(h.engine.getDevice(rule.deviceId)!.name, 'Autre nom');
    h.rules.update('admin', rule.id, { spec: spec(OFF, { where: { doors: ['A-02', 'A-01'] } }) });
    assert.deepEqual(h.engine.getSnapshot().links[rule.deviceId], ['C-01', 'C-02', 'C-04']);
    h.rules.update('admin', rule.id, { spec: spec(OFF, { where: { doors: ['A-03'] } }) });
    assert.equal(h.engine.getDevice(rule.deviceId)!.zone, 'Atelier', '1re porte changee : le detecteur la suit');
    assert.deepEqual(h.engine.getSnapshot().links[rule.deviceId], ['C-04', 'C-05']);
  });

  it("aucune porte declaree : refus 400 « Aucune porte n'est déclarée » pour « toutes les portes », et rien n'est cree", () => {
    const h = setup();
    h.db.exec('DELETE FROM access_door');
    refused(() => create(h, spec(OFF)), /Aucune porte n'est déclarée/);
    refused(() => create(h, spec(OFF, { where: { doors: ['A-01'] } })), /porte inconnue ou non déclarée/);
    assert.equal(h.rules.list().length, 0);
    assert.equal(h.engine.getDevice('R-1'), null);
  });

  it("« toutes les portes » est dynamique : une porte declaree plus tard est couverte (mais ses cameras ne sont liees qu'a la prochaine mise a jour)", () => {
    const h = setup();
    const rule = create(h, spec(OFF));
    h.engine.createDevice('admin', { id: 'A-04', kind: 'detector', name: 'Nouvelle porte', zone: 'Stockage', category: 'access' });
    h.db.prepare("INSERT INTO access_door (detector_id, controller_id, door_no) VALUES ('A-04', 'CTL-1', 4)").run();
    h.passages.emit(pass(T1, { doorId: 'A-04' }));
    assert.equal(h.status(rule.deviceId), 'prealarm');
    assert.equal(h.incidents(rule.deviceId)[0].detail?.includes('Nouvelle porte'), true);
  });
});

describe("regles d'acces : direct", () => {
  it('badge hors horaires : un passage ouvre un incident avec le motif, la porte et l\'heure ; retour a la normale 60 s apres le dernier passage', () => {
    const h = setup();
    const rule = create(h, spec(OFF, { then: { severity: 'critical' } }));
    h.passages.emit(pass(T1, { doorId: 'A-02', credential: '0012345' }));
    assert.equal(h.status(rule.deviceId), 'alarm');
    const [incident] = h.incidents(rule.deviceId);
    assert.equal(incident.severity, 'critical');
    assert.equal(incident.event, 'badge_offhours');
    assert.equal(incident.detail, 'Badge du titulaire H7 (groupe « Nuit ») utilisé hors de ses horaires à la porte « Entree principale » à 14:00, passage accepté.');
    assert.deepEqual(incident.cameraIds, ['C-01', 'C-02', 'C-04', 'C-05'], 'les cameras liees a l\'incident');
    assert.deepEqual(h.sent.map((m) => m.payload), [{ event: 'badge_offhours', detail: incident.detail }]);
    h.runTo(T1 + 59 * S);
    assert.equal(h.status(rule.deviceId), 'alarm');
    h.passages.emit(pass(T1 + 59 * S, { doorId: 'A-01' })); // prolonge
    h.runTo(T1 + 118 * S);
    assert.equal(h.status(rule.deviceId), 'alarm');
    h.runTo(T1 + 119 * S);
    assert.equal(h.status(rule.deviceId), 'normal', '59 + 60 = 119');
    assert.deepEqual(h.sent.map((m) => m.payload.event), ['badge_offhours', 'clear']);
  });

  it('gravite « warning » : pre-alarme, evenement _noticed', () => {
    const h = setup();
    const rule = create(h, spec(OFF));
    h.passages.emit(pass(T1));
    assert.equal(h.status(rule.deviceId), 'prealarm');
    assert.equal(h.incidents(rule.deviceId)[0].event, 'badge_offhours_noticed');
    assert.equal(h.incidents(rule.deviceId)[0].severity, 'warning');
  });

  it('badge surveille par numero : le texte ne contient ni le numero ni le nom', () => {
    const h = setup();
    const rule = create(h, spec(WATCH_BADGE, { then: { severity: 'critical' } }), 'Badge perdu');
    h.passages.emit(pass(T1, { doorId: 'A-03', credential: '0012345', holderId: null, holderRef: null, result: 'denied' }));
    const [incident] = h.incidents(rule.deviceId);
    assert.equal(incident.event, 'badge_watched');
    assert.equal(incident.detail, 'Badge surveillé utilisé à la porte « Porte atelier » à 14:00 : badge non rattaché à un titulaire, passage refusé.');
    assert.ok(!JSON.stringify(h.sent).includes('0012345'));
  });

  it('refus sur plusieurs portes : declenche au second refus', () => {
    const h = setup();
    const rule = create(h, spec(SPREAD, { then: { severity: 'critical' } }));
    h.passages.emit(denied(T1, { doorId: 'A-01' }));
    assert.equal(h.status(rule.deviceId), 'normal', 'un refus isole n\'est jamais une alarme');
    h.set(T1 + 20 * S);
    h.passages.emit(denied(T1 + 20 * S, { doorId: 'A-02' }));
    assert.equal(h.status(rule.deviceId), 'alarm');
    assert.equal(h.incidents(rule.deviceId)[0].event, 'denials_spread');
  });

  it('une regle desactivee, une porte hors portee, ou une absence de flux ne declenchent rien', () => {
    const h = setup();
    const off = create(h, spec(OFF), 'Desactivee', { enabled: false });
    const scoped = create(h, spec(OFF, { where: { doors: ['A-02'] } }), 'Porte A-02');
    h.passages.emit(pass(T1, { doorId: 'A-01' }));
    assert.equal(h.status(off.deviceId), 'normal');
    assert.equal(h.status(scoped.deviceId), 'normal');
    assert.deepEqual(h.sent, []);
    h.passages.emit(pass(T1 + S, { doorId: 'A-02' }));
    assert.equal(h.status(scoped.deviceId), 'prealarm');
    assert.equal(h.status(off.deviceId), 'normal');
    assert.equal(h.sent.length, 1);
  });

  it("sans `passages` ou sans `holders` : les regles existent, ne declenchent rien, et ne plantent pas", () => {
    const noFeed = setup({ withPassages: false });
    const r = create(noFeed, spec(OFF));
    assert.equal(r.kind, 'access');
    noFeed.passages.emit(pass(T1));
    noFeed.runTo(T1 + 10 * S);
    assert.deepEqual(noFeed.sent, []);
    const noHolders = setup({ withHolders: false });
    create(noHolders, spec(OFF));
    create(noHolders, spec(WATCH_BADGE), 'Autre');
    noHolders.passages.emit(pass(T1));
    assert.equal(noHolders.sent.length, 1, 'seul « badge surveille » n\'a pas besoin des titulaires');
    assert.equal(noHolders.sent[0].deviceId, 'R-2');
  });

  it("un passage ne touche pas une regle de presence, et la presence ne touche pas une regle d'acces", () => {
    const h = setup();
    create(h, spec(WATCH_BADGE));
    assert.equal(h.passages.listenerCount(), 1, 'un seul abonnement aux passages pour toutes les regles');
    const presence: RuleSpec = { who: { type: 'anyone' }, where: { cameras: ['C-01'] }, when: { type: 'always' }, trigger: { type: 'appears' }, then: { severity: 'critical' }, cooldownMinutes: 10 };
    const p = h.rules.create('admin', { name: 'Presence', spec: presence });
    assert.equal(p.kind, 'presence');
    h.passages.emit(pass(T1));
    assert.deepEqual(h.sent.map((m) => m.deviceId), ['R-1']);
  });

  it('close() retire l\'abonnement aux passages', () => {
    const h = setup();
    create(h, spec(WATCH_BADGE));
    h.rules.close();
    assert.equal(h.passages.listenerCount(), 0);
    h.passages.emit(pass(T1));
    assert.deepEqual(h.sent, []);
  });

  it("une lecture des titulaires qui echoue ne gene ni les autres regles ni l'ingestion des passages", () => {
    const h = setup();
    create(h, spec(OFF), 'Hors horaires');
    const watch = create(h, spec(WATCH_BADGE), 'Badge');
    h.holders.groupsOf = () => {
      throw new Error('base des titulaires illisible');
    };
    const originalError = console.error;
    console.error = () => {};
    try {
      assert.doesNotThrow(() => h.passages.emit(pass(T1)));
    } finally {
      console.error = originalError;
    }
    assert.equal(h.status(watch.deviceId), 'prealarm', 'la regle de badge surveille a quand meme declenche');
    assert.equal(h.status('R-1'), 'normal');
  });

  it('tick : le retour au calme se fait sans nouveau passage', () => {
    const h = setup();
    const rule = create(h, spec(WATCH_BADGE), 'Badge', { enabled: true });
    h.passages.emit(pass(T1));
    h.runTo(T1 + 59 * S);
    assert.equal(h.status(rule.deviceId), 'prealarm');
    h.runTo(T1 + 60 * S);
    assert.equal(h.status(rule.deviceId), 'normal');
  });
});

describe("regles d'acces : cycle de vie, journal, redemarrage", () => {
  it('desactiver : clear ; reactiver : la regle reprend ; supprimer sans incident : le detecteur disparait', () => {
    const h = setup();
    const rule = create(h, spec(WATCH_BADGE));
    h.passages.emit(pass(T1));
    assert.equal(h.status(rule.deviceId), 'prealarm');
    const off = h.rules.update('admin', rule.id, { enabled: false });
    assert.equal(off.enabled, false);
    assert.equal(h.status(rule.deviceId), 'normal', 'clear a la desactivation');
    h.passages.emit(pass(T1 + 5 * S));
    assert.equal(h.sent.filter((m) => m.payload.event !== 'clear').length, 1, 'plus rien tant qu\'elle est desactivee');
    h.rules.update('admin', rule.id, { enabled: true });
    h.passages.emit(pass(T1 + 10 * S));
    assert.equal(h.sent.filter((m) => m.payload.event !== 'clear').length, 2);

    const other = create(h, spec(OFF), 'Sans incident');
    h.rules.remove('admin', other.id);
    assert.equal(h.engine.getDevice(other.deviceId), null);
    assert.equal(h.rules.get(other.id), null);
  });

  it("supprimer une regle qui a deja declenche un incident : 409 (la desactiver)", () => {
    const h = setup();
    const rule = create(h, spec(WATCH_BADGE));
    h.passages.emit(pass(T1));
    assert.throws(() => h.rules.remove('admin', rule.id), (e: unknown) => e instanceof PsimError && e.status === 409);
    assert.ok(h.rules.get(rule.id), 'la regle est toujours la');
    h.rules.update('admin', rule.id, { enabled: false });
    assert.throws(() => h.rules.remove('admin', rule.id), (e: unknown) => e instanceof PsimError && e.status === 409, 'meme desactivee : l\'historique est conserve');
    assert.equal(h.rules.get(rule.id)?.enabled, false);
  });

  it("modifier la regle (spec ou portee) la reconstruit : l'ancien declenchement est clos, la nouvelle machine repart a zero", () => {
    const h = setup();
    const rule = create(h, spec(WATCH_BADGE));
    h.passages.emit(pass(T1));
    assert.equal(h.status(rule.deviceId), 'prealarm');
    h.rules.update('admin', rule.id, { spec: spec(WATCH_BADGE, { where: { doors: ['A-02'] } }) });
    assert.equal(h.status(rule.deviceId), 'normal');
    h.passages.emit(pass(T1 + S, { doorId: 'A-01' }));
    assert.equal(h.status(rule.deviceId), 'normal', 'A-01 n\'est plus dans la portee');
    h.passages.emit(pass(T1 + 2 * S, { doorId: 'A-02' }));
    assert.equal(h.status(rule.deviceId), 'prealarm', 'repos non mémorisé après reconstruction : redeclenche');
  });

  it('journal d\'audit : memes actions que les regles de presence, phrase SANS nom de titulaire ni numero de badge, phrase d\'origine a la creation', () => {
    const h = setup();
    const rule = create(h, spec(WATCH_BADGE, { where: { doors: ['A-01'] } }), 'Badge perdu', { sourceText: 'Surveiller le badge 0012345 de Awa Koné' });
    h.rules.update('admin', rule.id, { spec: spec(WATCH_HOLDER, { where: { doors: ['A-01'] } }) });
    h.rules.update('admin', rule.id, { enabled: false });
    h.rules.update('admin', rule.id, { enabled: true });
    const trail = h.audit();
    assert.deepEqual(trail.map((a) => a.action), ['rule_created', 'rule_updated', 'rule_disabled', 'rule_enabled']);
    assert.match(trail[0].details!, /phrase d'origine : « Surveiller le badge 0012345 de Awa Koné »/, 'la phrase d\'origine reste inscrite');
    assert.match(trail[0].details!, /si le badge surveillé est utilisé/);
    const phrases = [trail[0].details!.split(' | phrase')[0], trail[1].details!];
    for (const text of phrases) assert.doesNotMatch(text, /0012345|Awa|Koné/, `fuite dans le journal : ${text}`);
    assert.match(trail[1].details!, /titulaire H7/);
    // la phrase lue par les ecrans (summary) peut, elle, nommer le titulaire
    assert.match(h.rules.get(rule.id)!.summary, /Awa Koné/);
    h.rules.update('admin', rule.id, { enabled: false });
    const other = create(h, spec(WATCH_BADGE), 'A supprimer');
    h.rules.remove('admin', other.id);
    assert.doesNotMatch(h.audit().find((a) => a.action === 'rule_deleted')!.details!, /0012345/);
  });

  it('redemarrage : la regle activee repart (nouveau moteur de regles), detecteur manquant recree, alarme laissee retombe', () => {
    const h = setup();
    const rule = create(h, spec(WATCH_BADGE), 'Badge', { enabled: true });
    h.restart();
    h.passages.emit(pass(T1));
    assert.equal(h.status(rule.deviceId), 'prealarm', 'la regle recouvre son flux apres le redemarrage');
    // arret brutal alors que le detecteur sonnait : au redemarrage la machine est au repos, le detecteur est remis a la normale
    h.restart();
    assert.equal(h.status(rule.deviceId), 'normal');
    // detecteur supprime hors regles : recree avec zone et liens
    h.db.prepare('DELETE FROM incident WHERE detector_id = ?').run(rule.deviceId);
    h.engine.deleteDevice('admin', rule.deviceId);
    assert.equal(h.engine.getDevice(rule.deviceId), null);
    h.restart();
    assert.ok(h.engine.getDevice(rule.deviceId), 'detecteur recree');
    assert.deepEqual(h.engine.getSnapshot().links[rule.deviceId], ['C-01', 'C-02', 'C-04', 'C-05']);
  });

  it("une porte retiree de la portee d'une regle enregistree est tolerée au chargement (mais refusee a la saisie)", () => {
    const h = setup();
    const rule = create(h, spec(WATCH_BADGE, { where: { doors: ['A-01', 'A-02'] } }));
    h.db.prepare("DELETE FROM access_door WHERE detector_id = 'A-02'").run();
    assert.doesNotThrow(() => h.restart());
    assert.equal(h.rules.get(rule.id)?.kind, 'access');
    assert.equal(h.rules.list().length, 1);
    h.passages.emit(pass(T1, { doorId: 'A-01' }));
    assert.equal(h.status(rule.deviceId), 'prealarm', 'les portes restantes fonctionnent');
    refused(() => h.rules.update('admin', rule.id, { spec: spec(WATCH_BADGE, { where: { doors: ['A-01', 'A-02'] } }) }), /porte inconnue ou non déclarée « A-02 »/);
    refused(() => create(h, spec(WATCH_BADGE, { where: { doors: ['A-02'] } })), /porte inconnue/);
  });

  it("une regle d'acces n'est jamais « a revoir » ; l'activation d'une regle desactivee fonctionne", () => {
    const h = setup();
    const rule = create(h, spec(OFF), 'Nuit', { enabled: false });
    assert.equal(rule.needsReview, false);
    assert.equal(h.rules.update('admin', rule.id, { enabled: true }).enabled, true);
  });

  it('validation a la saisie : les memes refus 400 que validateAccessSpec, aucun detecteur cree', () => {
    const h = setup();
    refused(() => h.rules.create('admin', { name: 'x', spec: { ...spec(OFF), extra: 1 } }), /champ « extra »/);
    refused(() => h.rules.create('admin', { name: 'x', spec: { ...spec(SPREAD), what: { ...SPREAD, doors: 5 } } }), /nombre de portes/);
    refused(() => h.rules.create('admin', { name: 'x', spec: spec(OFF, { where: { doors: ['A-99'] } }) }), /porte inconnue/);
    refused(() => h.rules.create('admin', { name: '', spec: spec(OFF) }), /Nom de la regle requis/);
    assert.equal(h.engine.getDevice('R-1'), null);
    assert.equal(h.rules.list().length, 0);
    assert.deepEqual(h.rules.validate(spec(OFF)), spec(OFF));
  });
});

describe("regles d'acces : essai sur le passe", () => {
  const FROM = local(5, 0, 0, 0);
  const TO = local(12, 23, 59, 59);

  it('rejoue les passages dans la MEME machine que le direct : memes declenchements, avec porte et texte', () => {
    const history: PassageNote[] = [
      denied(local(6, 14, 0, 0), { doorId: 'A-01' }),
      denied(local(6, 14, 0, 30), { doorId: 'A-02' }), // declenche
      denied(local(6, 14, 0, 50), { doorId: 'A-03' }), // prolonge
      denied(local(6, 20, 0, 0), { doorId: 'A-01' }),
      denied(local(6, 20, 5, 0), { doorId: 'A-02' }), // 5 min apres : hors fenetre, aucun declenchement
      denied(local(8, 9, 0, 0), { doorId: 'A-01' }),
      denied(local(8, 9, 0, 10), { doorId: 'A-03' }), // declenche
    ];
    const s = spec(SPREAD);

    // direct : meme historique, un tick par seconde
    const live = setup();
    create(live, s);
    live.set(local(6, 13, 59, 0));
    for (const p of history) {
      live.runTo(p.at);
      live.passages.emit(p);
    }
    live.runTo(local(8, 12, 0, 0));
    const liveStarts = live.sent.filter((m) => m.payload.event !== 'clear').map((m) => T1 + m.sec * S);
    const liveEnds = live.sent.filter((m) => m.payload.event === 'clear').map((m) => T1 + m.sec * S);

    // essai : meme historique
    const trial = setup();
    trial.passages.seed(history);
    const result = trial.rules.simulate(s, FROM, TO);
    assert.deepEqual(result.triggers.map((t) => t.at), liveStarts, 'memes declenchements que le direct');
    assert.deepEqual(result.triggers.map((t) => t.endedAt), liveEnds, 'memes fins que le direct');
    assert.deepEqual(result.triggers.map((t) => t.at), [local(6, 14, 0, 30), local(8, 9, 0, 10)]);
    assert.deepEqual(result.triggers.map((t) => t.endedAt), [local(6, 14, 1, 50), local(8, 9, 1, 10)], 'retour au calme 60 s apres le dernier refus correspondant');
    assert.deepEqual(result.triggers.map((t) => t.doorId), ['A-02', 'A-03']);
    assert.deepEqual(result.triggers.map((t) => t.cameraId), ['', '']);
    assert.match(result.triggers[0].detail!, /^2 refus sur 2 portes différentes/);
    assert.match(result.triggers[0].detail!, /14:00/);
    assert.equal(trial.sent.length, 0, 'aucun message au moteur pendant un essai');
    assert.equal(trial.engine.getDevice('R-1'), null, 'et aucun detecteur cree');
    assert.match(result.summary, /^Prévenir \(avertissement\) si 2 refus ou plus/);
    assert.equal(result.note, undefined, 'pas de limite a signaler pour des refus (les droits ne servent pas)');
  });

  it("badge hors horaires : droits d'AUJOURD'HUI appliques aux heures passees (limite signalee dans `note`)", () => {
    const h = setup();
    h.passages.seed([pass(local(6, 14, 0)), pass(local(6, 23, 0), { doorId: 'A-02' }), pass(local(7, 3, 0))]);
    const result = h.rules.simulate(spec(OFF), FROM, TO);
    assert.deepEqual(result.triggers.map((t) => t.at), [local(6, 14, 0)], 'les passages de nuit sont dans les horaires du groupe Nuit');
    assert.match(result.note!, /droits des titulaires sont ceux d'aujourd'hui/);
    assert.match(result.triggers[0].detail!, /à 14:00/);
    assert.doesNotMatch(JSON.stringify(result), /0012345/);
  });

  it('badge surveille : tous les passages du badge, un declenchement par episode (repos entre deux)', () => {
    const h = setup();
    h.passages.seed([pass(local(6, 10, 0, 0)), pass(local(6, 10, 0, 30)), pass(local(6, 10, 5, 0)), pass(local(6, 10, 30, 0)), pass(local(6, 10, 0, 40), { credential: '999' })]);
    const result = h.rules.simulate(spec(WATCH_BADGE), FROM, TO);
    assert.deepEqual(result.triggers.map((t) => t.at), [local(6, 10, 0, 0), local(6, 10, 30, 0)], '10:05 est dans le repos de 10 min qui suit 10:01:30');
    assert.equal(result.triggers[0].endedAt, local(6, 10, 1, 30));
  });

  it('sans journal des passages : aucun declenchement, et la limite est dite', () => {
    const h = setup({ withPassages: false });
    const result = h.rules.simulate(spec(WATCH_BADGE), FROM, TO);
    assert.deepEqual(result.triggers, []);
    assert.match(result.note!, /journal des passages n'est pas disponible/);
  });

  it("n'inclut que les portes de la portee, et seulement les declenchements de la periode", () => {
    const h = setup();
    h.passages.seed([pass(local(6, 10, 0), { doorId: 'A-03' }), pass(local(6, 11, 0), { doorId: 'A-02' }), pass(local(14, 11, 0), { doorId: 'A-02' })]);
    const result = h.rules.simulate(spec(WATCH_BADGE, { where: { doors: ['A-02'] } }), FROM, TO);
    assert.deepEqual(result.triggers.map((t) => t.at), [local(6, 11, 0)], 'A-03 hors portee ; le 14 est apres la periode');
  });

  it('periode invalide ou specification invalide : 400, comme pour les regles de presence', () => {
    const h = setup();
    refused(() => h.rules.simulate(spec(OFF), TO, FROM), /Periode invalide/);
    refused(() => h.rules.simulate(spec(OFF), FROM, FROM + 32 * 86_400_000), /Periode trop longue/);
    refused(() => h.rules.simulate({ ...spec(OFF), what: { type: 'inconnu' } }, FROM, TO), /^Si : /);
  });

  it('une regle de presence garde exactement la meme forme de resultat (at, endedAt, cameraId)', () => {
    const h = setup();
    const presence: RuleSpec = { who: { type: 'anyone' }, where: { cameras: ['C-01'] }, when: { type: 'always' }, trigger: { type: 'appears' }, then: { severity: 'critical' }, cooldownMinutes: 10 };
    const result = h.rules.simulate(presence, FROM, TO);
    assert.deepEqual(result, { summary: result.summary, triggers: [] });
    assert.ok(!('note' in result));
  });
});

describe("regles de presence : create / update inchanges par les regles d'acces", () => {
  const presence: RuleSpec = { who: { type: 'anyone' }, where: { cameras: ['C-01'] }, when: { type: 'always' }, trigger: { type: 'appears' }, then: { severity: 'critical' }, cooldownMinutes: 10 };

  it('une specification sans `kind` est une regle de presence : kind « presence », detecteur sur la camera, phrase inchangee', () => {
    const h = setup();
    const rule = h.rules.create('admin', { name: 'Cour', spec: presence });
    assert.equal(rule.kind, 'presence');
    assert.deepEqual(rule.spec, presence);
    assert.equal(h.engine.getDevice('R-1')!.zone, h.engine.getDevice('C-01')!.zone);
    assert.deepEqual(h.engine.getSnapshot().links['R-1'], ['C-01']);
    assert.match(rule.summary, /^Prévenir \(alerte critique\) si quelqu'un apparaît devant la caméra « Camera accueil »/);
    const changed = h.rules.update('admin', rule.id, { spec: { ...presence, where: { cameras: ['C-01', 'C-02'] } } });
    assert.deepEqual(h.engine.getSnapshot().links['R-1'], ['C-01', 'C-02']);
    assert.equal(changed.kind, 'presence');
  });

  it('un champ `kind` autre que « access » sur une regle de presence est refuse (champ non reconnu)', () => {
    const h = setup();
    refused(() => h.rules.create('admin', { name: 'x', spec: { ...presence, kind: 'presence' } }), /champ « kind » non reconnu/);
    refused(() => h.rules.create('admin', { name: 'x', spec: { ...presence, kind: 'autre' } }), /champ « kind » non reconnu/);
  });

  it("melanger les deux formes est refuse : une regle d'acces avec `who`, une regle de presence avec `what`", () => {
    const h = setup();
    refused(() => h.rules.create('admin', { name: 'x', spec: { ...spec(OFF), who: { type: 'anyone' } } }), /champ « who » non reconnu/);
    refused(() => h.rules.create('admin', { name: 'x', spec: { ...presence, what: OFF } }), /champ « what » non reconnu/);
  });

  it("une regle de presence peut devenir une regle d'acces (et inversement) : detecteur, zone et liens suivent", () => {
    const h = setup();
    const rule = h.rules.create('admin', { name: 'Cour', spec: presence });
    const access = h.rules.update('admin', rule.id, { spec: spec(OFF, { where: { doors: ['A-03'] } }) });
    assert.equal(access.kind, 'access');
    assert.equal(h.engine.getDevice(rule.deviceId)!.zone, 'Atelier');
    assert.deepEqual(h.engine.getSnapshot().links[rule.deviceId], ['C-04', 'C-05']);
    const back = h.rules.update('admin', rule.id, { spec: presence });
    assert.equal(back.kind, 'presence');
    assert.deepEqual(h.engine.getSnapshot().links[rule.deviceId], ['C-01']);
  });

  it('list() melange les deux sortes de regles, chacune avec son kind', () => {
    const h = setup();
    h.rules.create('admin', { name: 'Cour', spec: presence });
    create(h, spec(OFF), 'Nuit');
    assert.deepEqual(h.rules.list().map((r) => [r.id, r.kind]), [[1, 'presence'], [2, 'access']]);
  });
});
