/**
 * Essais de la synchronisation des titulaires cote module (gateway/src/modules/acces-commun/sync.ts et slots.ts) :
 * validation d'ordres hostiles, correspondance persistee des plages horaires, gestionnaire commun (serialisation, capacite,
 * echec du controleur sans attribution fantome, idempotence). Horloge injectee, aucun reseau, aucune attente reelle ; les
 * fichiers vont dans un dossier temporaire.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import type { ModuleContext } from '../src/module.ts';
import type { Window } from '../../server/arming.ts';
import {
  ActuatorFailure,
  HOLDER_REF,
  SCHEDULE_REF,
  SLOTS_FILE,
  SlotMap,
  makeSyncHandler,
  parseSyncBody,
  registerAccessSync,
  validCalendarDate,
} from '../src/modules/acces-commun/commun.ts';
import type { AccessSyncHandler, AccessSyncOp, SyncDriver, SyncWindow } from '../src/modules/acces-commun/commun.ts';

const T0 = 1_760_000_000_000;
const OPID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

const tmpDirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'acces-sync-'));
  tmpDirs.push(d);
  return d;
}
after(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

// Le type local `SyncWindow` doit rester identique a `Window` de server/arming.ts (verifie par le compilateur).
const _a: SyncWindow = { days: [1], from: '08:00', to: '17:00' } satisfies Window;
const _b: Window = _a;
void _b;

const cp = (...codes: number[]): string => String.fromCodePoint(...codes);

function holderBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'upsert_holder',
    holderRef: 'H101',
    name: 'KONAN Yao',
    active: true,
    validFrom: null,
    validTo: null,
    credentials: ['0012345'],
    doors: [{ doorNo: 1, scheduleRef: null }],
    ...over,
  };
}
const scheduleBody = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'upsert_schedule',
  scheduleRef: 'S1',
  windows: [{ days: [1, 2, 3, 4, 5], from: '08:00', to: '17:00' }],
  holidays: true,
  ...over,
});
const op = (body: Record<string, unknown>, seq = 1): AccessSyncOp => ({ opId: OPID, seq, ...body }) as unknown as AccessSyncOp;

function bad(raw: unknown, expected?: RegExp): string {
  const r = parseSyncBody(raw);
  assert.equal(r.ok, false, `devait etre refuse : ${safe(raw)}`);
  if (r.ok) return '';
  assert.ok(typeof r.error === 'string' && r.error.length > 0);
  if (expected) assert.match(r.error, expected);
  return r.error;
}
function good(raw: unknown) {
  const r = parseSyncBody(raw);
  assert.equal(r.ok, true, `devait etre accepte : ${safe(raw)} -> ${r.ok ? '' : r.error}`);
  if (!r.ok) throw new Error('refuse');
  return r.op;
}
function safe(v: unknown): string {
  try {
    return JSON.stringify(v)?.slice(0, 200) ?? String(v);
  } catch {
    return '[illisible]';
  }
}

// ---------------------------------------------------------------------------------------------------------------------
describe('acces-sync : registerAccessSync', () => {
  const handler: AccessSyncHandler = async () => ({ result: 'done' });
  const KEY = 'ab'.repeat(32);

  it("appelle ctx.onAccessSync(controllerId, handler, { key }) et rend vrai", () => {
    const calls: unknown[][] = [];
    const ctx = { onAccessSync: (...args: unknown[]) => void calls.push(args), log: () => undefined } as unknown as ModuleContext;
    assert.equal(registerAccessSync(ctx, 'CTL-1', handler, KEY), true);
    assert.deepEqual(calls, [['CTL-1', handler, { key: KEY }]]);
  });

  it("rend faux sans exception quand le contexte n'offre pas onAccessSync (ou quand il n'est pas une fonction)", () => {
    assert.equal(registerAccessSync({} as ModuleContext, 'CTL-1', handler, KEY), false);
    assert.equal(registerAccessSync({ onAccessSync: 'non' } as unknown as ModuleContext, 'CTL-1', handler, KEY), false);
    assert.equal(registerAccessSync({ onAccessSync: null } as unknown as ModuleContext, 'CTL-1', handler, KEY), false);
    assert.equal(registerAccessSync(undefined as unknown as ModuleContext, 'CTL-1', handler, KEY), false);
    assert.equal(registerAccessSync(null as unknown as ModuleContext, 'CTL-1', handler, KEY), false);
    const logs: string[] = [];
    assert.equal(registerAccessSync({ log: (l: string, t: string) => void logs.push(`${l} ${t}`) } as unknown as ModuleContext, 'CTL-1', handler, KEY), false);
    assert.equal(logs.length, 1);
    assert.match(logs[0]!, /^info controleur CTL-1 : synchronisation des titulaires indisponible/);
  });

  it('conserve le this du contexte', () => {
    let seen: unknown = null;
    const ctx = {
      tag: 'ctx',
      onAccessSync(this: unknown) {
        seen = this;
      },
    };
    registerAccessSync(ctx as unknown as ModuleContext, 'CTL-1', handler, KEY);
    assert.equal(seen, ctx);
  });

  it('le socle leve (cle invalide, controleur deja pris...) : faux, avertissement clair, jamais la cle, jamais d\'exception', () => {
    const logs: { level: string; text: string }[] = [];
    const ctx = {
      onAccessSync: () => {
        throw new Error('controleur « CTL-1 » deja enregistre par le module « acces-zkteco »');
      },
      log: (level: string, text: string) => void logs.push({ level, text }),
    } as unknown as ModuleContext;
    assert.equal(registerAccessSync(ctx, 'CTL-1', handler, KEY), false);
    assert.equal(logs.length, 1);
    assert.equal(logs[0]!.level, 'warn');
    assert.match(logs[0]!.text, /controleur CTL-1 : synchronisation des titulaires non enregistree, surveillance des portes seule \(controleur « CTL-1 » deja enregistre/);
    assert.equal(logs[0]!.text.includes(KEY), false);
    // Journal qui leve, erreur qui n'est pas une Error, identifiant hostile : toujours faux, jamais d'exception.
    const throwing = (): never => {
      throw 'texte brut';
    };
    assert.equal(registerAccessSync({ onAccessSync: throwing, log: throwing } as unknown as ModuleContext, 'CTL-1', handler, KEY), false);
    const seen: string[] = [];
    const hostile = { onAccessSync: throwing, log: (_l: string, t: string) => void seen.push(t) } as unknown as ModuleContext;
    assert.equal(registerAccessSync(hostile, `X${String.fromCharCode(10)}Y`.repeat(30), handler, KEY), false);
    assert.equal(/\p{Cc}/u.test(seen[0]!), false, 'aucun caractere de controle dans le journal');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('acces-sync : parseSyncBody - corps valides', () => {
  it('upsert_holder complet', () => {
    const r = good(holderBody({ validFrom: T0, validTo: T0 + 86_400_000, credentials: ['0012345', 'AB-12'], doors: [{ doorNo: 1, scheduleRef: 'S1' }, { doorNo: 4, scheduleRef: null }] }));
    assert.deepEqual(r, {
      type: 'upsert_holder',
      holderRef: 'H101',
      name: 'KONAN Yao',
      active: true,
      validFrom: T0,
      validTo: T0 + 86_400_000,
      credentials: ['0012345', 'AB-12'],
      doors: [{ doorNo: 1, scheduleRef: 'S1' }, { doorNo: 4, scheduleRef: null }],
    });
  });

  it('upsert_holder minimal : sans badge, sans porte, inactif, bornes a 0', () => {
    const r = good(holderBody({ active: false, credentials: [], doors: [], validFrom: 0, validTo: 1 }));
    assert.equal(r.type, 'upsert_holder');
    if (r.type === 'upsert_holder') {
      assert.deepEqual(r.credentials, []);
      assert.deepEqual(r.doors, []);
      assert.equal(r.validFrom, 0);
    }
  });

  it('une seule borne de validite est acceptee', () => {
    good(holderBody({ validFrom: T0, validTo: null }));
    good(holderBody({ validFrom: null, validTo: T0 }));
  });

  it('delete_holder, delete_schedule', () => {
    assert.deepEqual(good({ type: 'delete_holder', holderRef: 'H7' }), { type: 'delete_holder', holderRef: 'H7' });
    assert.deepEqual(good({ type: 'delete_schedule', scheduleRef: 'S_a-1' }), { type: 'delete_schedule', scheduleRef: 'S_a-1' });
  });

  it('upsert_schedule : jours tries, plage passant minuit', () => {
    const r = good(scheduleBody({ windows: [{ days: [5, 1, 3], from: '22:00', to: '06:00' }], holidays: false }));
    assert.deepEqual(r, { type: 'upsert_schedule', scheduleRef: 'S1', windows: [{ days: [1, 3, 5], from: '22:00', to: '06:00' }], holidays: false });
  });

  it('upsert_schedule : 14 plages, 7 jours', () => {
    const windows = Array.from({ length: 14 }, () => ({ days: [0, 1, 2, 3, 4, 5, 6], from: '00:00', to: '23:59' }));
    good(scheduleBody({ windows }));
  });

  it('set_holidays : replace facultatif (faux par defaut), liste vide permise, 40 dates', () => {
    assert.deepEqual(good({ type: 'set_holidays', dates: ['2026-12-25', '2024-02-29'] }), { type: 'set_holidays', dates: ['2026-12-25', '2024-02-29'], replace: false });
    assert.deepEqual(good({ type: 'set_holidays', dates: [], replace: true }), { type: 'set_holidays', dates: [], replace: true });
    const dates = Array.from({ length: 40 }, (_, i) => `2027-${String(1 + (i % 12)).padStart(2, '0')}-${String(1 + Math.floor(i / 12)).padStart(2, '0')}`);
    assert.equal(new Set(dates).size, 40);
    good({ type: 'set_holidays', dates, replace: true });
  });

  it('opId et seq facultatifs : conserves s\'ils sont valides', () => {
    const r = good({ opId: OPID, seq: 42, ...holderBody() });
    assert.equal(r.opId, OPID);
    assert.equal(r.seq, 42);
    assert.equal(good(holderBody()).opId, undefined);
  });

  it('le resultat est une copie normalisee : modifier l\'entree apres coup ne le change pas', () => {
    const raw = holderBody();
    const r = good(raw);
    (raw.credentials as string[]).push('999');
    (raw.doors as unknown[]).length = 0;
    if (r.type === 'upsert_holder') {
      assert.deepEqual(r.credentials, ['0012345']);
      assert.equal(r.doors.length, 1);
    }
  });

  it('le nom est nettoye : controles et espaces multiples, caracteres invisibles retires', () => {
    const r = good(holderBody({ name: `  KONAN\t${cp(0x200b)}Yao\n  ${cp(0x202e)}` }));
    if (r.type === 'upsert_holder') assert.equal(r.name, 'KONAN Yao');
    const full = good(holderBody({ name: 'N'.repeat(64) }));
    if (full.type === 'upsert_holder') assert.equal(full.name.length, 64);
    good(holderBody({ name: `${'N'.repeat(64)}   ` }));
  });

  it('les expressions de reference sont celles du contrat', () => {
    assert.ok(HOLDER_REF.test('H1') && HOLDER_REF.test(`H${'a'.repeat(31)}`) && !HOLDER_REF.test(`H${'a'.repeat(32)}`));
    assert.ok(SCHEDULE_REF.test('S1') && !SCHEDULE_REF.test('S'));
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('acces-sync : parseSyncBody - entrees hostiles', () => {
  it('pas un objet simple : refus, jamais d\'exception', () => {
    class Evil {
      type = 'delete_holder';
      holderRef = 'H1';
    }
    for (const raw of [null, undefined, 0, 1, '', 'x', '{"type":"delete_holder"}', [], [holderBody()], true, false, Symbol('s'), () => 1, 10n, new Date(), new Map(), new Evil(), Object.create({ type: 'delete_holder', holderRef: 'H1' })]) {
      bad(raw);
    }
  });

  it('accesseur qui leve, Proxy hostile, objet circulaire : refus sans exception', () => {
    const getter = Object.defineProperty({}, 'type', {
      enumerable: true,
      get() {
        throw new Error('boom');
      },
    });
    bad(getter);
    const proxy = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('boom');
        },
        getPrototypeOf() {
          return Object.prototype;
        },
      },
    );
    bad(proxy);
    const circ: Record<string, unknown> = { type: 'delete_holder', holderRef: 'H1' };
    circ.self = circ;
    bad(circ, /inconnu/);
    const nested = holderBody({ doors: [{ doorNo: 1, scheduleRef: 'S1', get extra() { throw new Error('x'); } }] });
    bad(nested);
  });

  it('type inconnu ou piege', () => {
    for (const type of ['', 'UPSERT_HOLDER', 'upsert_holder ', 'toString', 'constructor', '__proto__', 'hasOwnProperty', 'drop_all', 5, null, undefined, ['upsert_holder'], {}]) {
      bad({ ...holderBody(), type });
    }
    bad({ holderRef: 'H1' });
  });

  it('champ inconnu : refus, sans reprendre le nom du champ dans le message', () => {
    for (const extra of ['extra', 'x'.repeat(5000), 'type2', 'Name', 'opid', 'seq2']) {
      const e = bad({ ...holderBody(), [extra]: 1 }, /inconnu/);
      assert.ok(!e.includes(extra) || extra.length < 3, 'pas d\'echo');
    }
    bad(JSON.parse('{"__proto__":{"admin":true},"type":"delete_holder","holderRef":"H1"}'), /inconnu/);
    bad({ type: 'delete_holder', holderRef: 'H1', name: 'x' }, /inconnu/);
    bad({ type: 'delete_schedule', scheduleRef: 'S1', holidays: true }, /inconnu/);
    bad({ type: 'upsert_schedule', scheduleRef: 'S1', windows: scheduleBody().windows, holidays: true, replace: true }, /inconnu/);
    bad({ type: 'set_holidays', dates: [], scheduleRef: 'S1' }, /inconnu/);
  });

  it('PIN, mot de passe, gabarit, photo, visage, empreinte : refus explicite, a tout niveau', () => {
    for (const field of ['pin', 'PIN', 'Pin', 'pin_code', 'pinCode', 'password', 'Password', 'passwd', 'template', 'photo', 'face', 'fingerprint', 'biometric', 'finger-print', 'PHOTO']) {
      const e = bad({ ...holderBody(), [field]: '1234' }, /interdit/);
      assert.ok(!e.includes('1234'));
      bad({ type: 'delete_holder', holderRef: 'H1', [field]: 'x' }, /interdit/);
      bad(holderBody({ doors: [{ doorNo: 1, scheduleRef: null, [field]: 'x' }] }), /interdit/);
      bad(scheduleBody({ windows: [{ days: [1], from: '08:00', to: '09:00', [field]: 'x' }] }), /interdit/);
      bad({ type: 'set_holidays', dates: [], [field]: 'x' }, /interdit/);
    }
    // meme avec un type inconnu : le champ interdit est signale
    bad({ type: 'zzz', pin: '1' }, /interdit/);
  });

  it('champ obligatoire manquant : refus (un validFrom absent n\'est pas un null)', () => {
    for (const key of ['holderRef', 'name', 'active', 'validFrom', 'validTo', 'credentials', 'doors']) {
      const b = holderBody();
      delete b[key];
      bad(b, /manquant/);
    }
    bad({ type: 'delete_holder' }, /manquant/);
    bad({ type: 'delete_schedule' }, /manquant/);
    bad({ type: 'upsert_schedule', scheduleRef: 'S1', windows: scheduleBody().windows }, /manquant/);
    bad({ type: 'set_holidays' }, /manquant/);
    // undefined explicite = absent pour JSON, mais ici la cle existe : le type est refuse
    bad(holderBody({ validFrom: undefined }));
  });

  it('holderRef / scheduleRef : forme stricte', () => {
    for (const ref of ['', 'H', 'h1', 'S1', 'H 1', 'H1\n', 'H1 ', `H${cp(0xe9)}`, `H${'a'.repeat(32)}`, 'H/1', 'H.1', 5, null, undefined, ['H1'], { toString: () => 'H1' }, 'H'.repeat(100_000)]) {
      bad(holderBody({ holderRef: ref }));
      bad({ type: 'delete_holder', holderRef: ref });
    }
    for (const ref of ['', 'S', 's1', 'H1', 'S 1', 'S1\n', `S${'a'.repeat(32)}`, 5, null, ['S1']]) {
      bad(scheduleBody({ scheduleRef: ref }));
      bad({ type: 'delete_schedule', scheduleRef: ref });
      if (ref !== null) bad(holderBody({ doors: [{ doorNo: 1, scheduleRef: ref }] }));
    }
    bad(holderBody({ doors: [{ doorNo: 1, scheduleRef: undefined }] }));
  });

  it('name : vide, trop long, pas du texte', () => {
    for (const name of ['', '   ', cp(0), `${cp(7)}${cp(8)}`, cp(0x200b), 'N'.repeat(65), `${'N'.repeat(40)} ${'N'.repeat(40)}`, 'x'.repeat(10_000_000), 5, null, true, {}, ['a'], undefined]) {
      bad(holderBody({ name }));
    }
  });

  it('active, holidays, replace : booleens seulement', () => {
    for (const v of ['true', 1, 0, null, undefined, 'yes', [], {}]) {
      bad(holderBody({ active: v }));
      bad(scheduleBody({ holidays: v }));
      bad({ type: 'set_holidays', dates: [], replace: v });
    }
  });

  it('validFrom / validTo : entier de ms >= 0 ou null ; validTo apres validFrom', () => {
    for (const v of [-1, 1.5, '5', Number.NaN, Infinity, -Infinity, 2 ** 53, 9e15, true, {}, [], undefined]) {
      bad(holderBody({ validFrom: v }));
      bad(holderBody({ validTo: v }));
    }
    bad(holderBody({ validFrom: T0, validTo: T0 }), /posterieur/);
    bad(holderBody({ validFrom: T0, validTo: T0 - 1 }), /posterieur/);
    good(holderBody({ validFrom: 0, validTo: 8.64e15 }));
  });

  it('credentials : au plus 4, propres, non vides, sans doublon', () => {
    for (const credentials of [
      ['1', '2', '3', '4', '5'],
      [''],
      [' 123'],
      ['123 '],
      ['a b'],
      ['x/y'],
      ['1'.repeat(33)],
      [123],
      [null],
      [undefined],
      [{}],
      [['1']],
      ['1', '1'],
      ['ab12', 'AB12'],
      'abc',
      {},
      null,
      new Array(3),
      new Array(1_000_000_000),
      [cp(0x661)],
    ]) {
      bad(holderBody({ credentials }));
    }
    good(holderBody({ credentials: ['1'.repeat(32), 'A.B:C-d_e', '2', '3'] }));
  });

  it('doors : au plus 4, numero 1 a 4 unique, objets stricts', () => {
    const d = (doorNo: unknown, scheduleRef: unknown = null) => ({ doorNo, scheduleRef });
    for (const doors of [
      [d(1), d(2), d(3), d(4), d(1)],
      [d(0)],
      [d(5)],
      [d(1.5)],
      [d('1')],
      [d(-1)],
      [d(null)],
      [d(1), d(1)],
      [{ doorNo: 1 }],
      [{ scheduleRef: null }],
      [{ doorNo: 1, scheduleRef: null, extra: 1 }],
      [null],
      [1],
      [[1, null]],
      'x',
      {},
      null,
      new Array(2),
    ]) {
      bad(holderBody({ doors }));
    }
    good(holderBody({ doors: [d(1, 'S1'), d(2, 'S2'), d(3), d(4, 'S9')] }));
  });

  it('windows : 1 a 14 plages valides', () => {
    const w = (over: Record<string, unknown> = {}) => ({ days: [1], from: '08:00', to: '17:00', ...over });
    for (const windows of [
      [],
      Array.from({ length: 15 }, () => w()),
      [w({ days: [] })],
      [w({ days: [7] })],
      [w({ days: [-1] })],
      [w({ days: [1, 1] })],
      [w({ days: ['1'] })],
      [w({ days: [1.5] })],
      [w({ days: [0, 1, 2, 3, 4, 5, 6, 0] })],
      [w({ days: 'lundi' })],
      [w({ days: null })],
      [w({ from: '24:00' })],
      [w({ to: '9:00' })],
      [w({ from: '09:60' })],
      [w({ from: '08:00', to: '08:00' })],
      [w({ from: '08:00 ' })],
      [w({ from: 800 })],
      [w({ from: null })],
      [{ days: [1], from: '08:00' }],
      [w({ extra: 1 })],
      [null],
      ['08:00-17:00'],
      [[1]],
      {},
      'x',
      null,
      undefined,
    ]) {
      bad(scheduleBody({ windows }));
    }
  });

  it('dates : vraies dates du calendrier seulement', () => {
    for (const d of [
      '2026-02-29',
      '2100-02-29',
      '2026-04-31',
      '2026-06-31',
      '2026-13-01',
      '2026-00-10',
      '2026-01-00',
      '2026-01-32',
      '2026-1-1',
      '20260101',
      '2026/01/01',
      '2026-01-01 ',
      ' 2026-01-01',
      '2026-01-01T00:00:00Z',
      '1969-12-31',
      '2201-01-01',
      '0000-01-01',
      `${cp(0x662)}${cp(0x660)}26-01-01`,
      5,
      null,
      undefined,
      {},
      ['2026-01-01'],
    ]) {
      bad({ type: 'set_holidays', dates: [d] });
    }
    bad({ type: 'set_holidays', dates: ['2026-12-25', '2026-12-25'] }, /double/);
    bad({ type: 'set_holidays', dates: Array.from({ length: 41 }, (_, i) => `2027-01-${String(1 + (i % 28)).padStart(2, '0')}`) });
    bad({ type: 'set_holidays', dates: '2026-12-25' });
    bad({ type: 'set_holidays', dates: null });
    for (const ok of ['2024-02-29', '2000-02-29', '2026-12-31', '1970-01-01', '2200-12-31', '2026-04-30']) assert.equal(validCalendarDate(ok), true, ok);
    assert.equal(validCalendarDate(2026), false);
  });

  it('opId et seq : formes strictes', () => {
    for (const opId of ['', 'a b', 'x'.repeat(65), 5, null, 'op\n1']) bad({ opId, ...holderBody() });
    for (const seq of [-1, 1.5, '1', Number.NaN, Infinity, 2 ** 53, null]) bad({ seq, ...holderBody() });
    good({ opId: 'op-1_x', seq: 0, ...holderBody() });
  });

  it('entrees enormes : refus rapide, sans exception', () => {
    bad(holderBody({ name: 'x'.repeat(50_000_000) }));
    bad(holderBody({ credentials: ['9'.repeat(50_000_000)] }));
    bad({ type: 'delete_holder', holderRef: `H${'a'.repeat(50_000_000)}` });
    bad({ type: 'set_holidays', dates: Array.from({ length: 1_000_000 }, () => '2026-01-01') });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('acces-sync : SlotMap', () => {
  function mkSlots(over: Partial<ConstructorParameters<typeof SlotMap>[0]> = {}) {
    const clock = { t: T0 };
    const logs: string[] = [];
    const writes: string[] = [];
    const dir = over.dir ?? tmp();
    const map = new SlotMap({
      dir,
      now: () => clock.t,
      log: (_l, text) => void logs.push(text),
      min: 1,
      max: 4,
      io: {
        write: (file, data) => {
          writes.push(data);
          writeFileSync(file, data);
        },
      },
      ...over,
    });
    return { map, clock, logs, writes, dir };
  }

  it('attribue le plus petit numero libre, de facon idempotente', () => {
    const { map } = mkSlots();
    assert.equal(map.allocate('CTL-1', 'S1'), 1);
    assert.equal(map.allocate('CTL-1', 'S2'), 2);
    assert.equal(map.allocate('CTL-1', 'S1'), 1, 'idempotent');
    assert.equal(map.allocate('CTL-1', 'S3'), 3);
    assert.equal(map.get('CTL-1', 'S2'), 2);
    assert.equal(map.get('CTL-1', 'S9'), null);
    assert.equal(map.get('CTL-9', 'S1'), null);
    assert.deepEqual(map.list('CTL-1'), [{ ref: 'S1', slot: 1 }, { ref: 'S2', slot: 2 }, { ref: 'S3', slot: 3 }]);
    assert.deepEqual(map.list('CTL-9'), []);
  });

  it('un numero libere est reutilise (le plus petit libre)', () => {
    const { map } = mkSlots();
    for (const r of ['S1', 'S2', 'S3']) map.allocate('CTL-1', r);
    assert.equal(map.release('CTL-1', 'S2'), true);
    assert.equal(map.release('CTL-1', 'S2'), false, 'deja libere');
    assert.equal(map.release('CTL-1', 'S99'), false);
    assert.equal(map.release('CTL-9', 'S1'), false);
    assert.equal(map.allocate('CTL-1', 'S4'), 2);
    assert.equal(map.allocate('CTL-1', 'S5'), 4);
    assert.equal(map.allocate('CTL-1', 'S6'), 'full');
    assert.equal(map.allocate('CTL-1', 'S1'), 1, 'une reference deja connue reste servie meme quand tout est plein');
  });

  it('plein : full, sans rien changer ; liberer redonne de la place', () => {
    const { map } = mkSlots({ min: 5, max: 6 });
    assert.equal(map.allocate('C', 'S1'), 5);
    assert.equal(map.allocate('C', 'S2'), 6);
    assert.equal(map.allocate('C', 'S3'), 'full');
    assert.equal(map.get('C', 'S3'), null);
    map.release('C', 'S1');
    assert.equal(map.allocate('C', 'S3'), 5);
  });

  it('chaque controleur a sa propre table', () => {
    const { map } = mkSlots();
    assert.equal(map.allocate('A', 'S1'), 1);
    assert.equal(map.allocate('B', 'S1'), 1);
    assert.equal(map.allocate('B', 'S2'), 2);
    map.release('A', 'S1');
    assert.equal(map.get('B', 'S1'), 1);
  });

  it('bornes invalides : RangeError', () => {
    const base = { dir: tmp(), now: () => T0, log: () => undefined };
    for (const [min, max] of [[-1, 4], [4, 1], [1.5, 4], [1, 4.5], [Number.NaN, 4], [1, Infinity], [0, 5000], ['1', 4]] as Array<[unknown, unknown]>) {
      assert.throws(() => new SlotMap({ ...base, min: min as number, max: max as number }), RangeError, `${String(min)}..${String(max)}`);
    }
    assert.doesNotThrow(() => new SlotMap({ ...base, min: 0, max: 0 }));
    assert.doesNotThrow(() => new SlotMap({ ...base, min: 0, max: 1023 }));
  });

  it('controleur ou reference invalides : full + avertissement, aucune attribution', () => {
    const { map, logs } = mkSlots();
    for (const [c, r] of [['', 'S1'], ['a b', 'S1'], ['C', 's1'], ['C', 'H1'], ['C', ''], ['C', 'S'], [5, 'S1'], ['C', 5], ['C', null]] as Array<[unknown, unknown]>) {
      assert.equal(map.allocate(c as string, r as string), 'full', `${String(c)}/${String(r)}`);
    }
    assert.equal(map.list('C').length, 0);
    assert.equal(logs.length, 1, 'journal limite');
  });

  it('trop de controleurs : refuse', () => {
    const { map } = mkSlots();
    for (let i = 0; i < 256; i++) assert.equal(map.allocate(`C${i}`, 'S1'), 1);
    assert.equal(map.allocate('C256', 'S1'), 'full');
    assert.equal(map.allocate('C0', 'S2'), 2, 'un controleur existant continue de fonctionner');
  });

  it('persistance : flush puis nouveau SlotMap sur le meme dossier (redemarrage)', () => {
    const { map, dir } = mkSlots();
    map.allocate('CTL-1', 'S1');
    map.allocate('CTL-1', 'S2');
    map.allocate('CTL-2', 'S7');
    map.release('CTL-1', 'S1');
    assert.equal(map.flush(), true);
    assert.deepEqual(readdirSync(dir), [SLOTS_FILE], 'aucun fichier temporaire restant');
    const again = mkSlots({ dir }).map;
    assert.equal(again.get('CTL-1', 'S1'), null);
    assert.equal(again.get('CTL-1', 'S2'), 2);
    assert.equal(again.get('CTL-2', 'S7'), 1);
    assert.equal(again.allocate('CTL-1', 'S3'), 1, 'le numero libere avant l\'arret est de nouveau libre');
    assert.equal(again.allocate('CTL-1', 'S4'), 3);
  });

  it('le contenu du fichier est un JSON simple, sans controleur vide', () => {
    const { map, dir } = mkSlots();
    map.allocate('CTL-1', 'S1');
    map.allocate('CTL-2', 'S1');
    map.release('CTL-2', 'S1');
    map.flush();
    assert.deepEqual(JSON.parse(readFileSync(join(dir, SLOTS_FILE), 'utf8')), { v: 1, controllers: { 'CTL-1': { S1: 1 } } });
  });

  it('tick() : au plus une ecriture par seconde (horloge injectee), horloge revenue en arriere geree', () => {
    const { map, clock, writes } = mkSlots();
    map.tick();
    assert.equal(writes.length, 0, 'rien a ecrire');
    map.allocate('C', 'S1');
    map.tick();
    assert.equal(writes.length, 1, 'premiere ecriture immediate');
    map.allocate('C', 'S2');
    clock.t += 500;
    map.tick();
    assert.equal(writes.length, 1, 'moins d\'une seconde : attend');
    clock.t += 500;
    map.tick();
    assert.equal(writes.length, 2);
    map.tick();
    assert.equal(writes.length, 2, 'rien de nouveau');
    map.allocate('C', 'S3');
    clock.t -= 3_600_000;
    map.tick();
    assert.equal(writes.length, 3, 'horloge revenue en arriere : ecrit tout de suite');
  });

  it('ecriture impossible : flush rend faux sans exception, l\'etat reste a ecrire et sera retente', () => {
    let fail = true;
    const { map, clock, logs, dir } = mkSlots({
      io: {
        write: (file, data) => {
          if (fail) throw new Error('disque plein');
          writeFileSync(file, data);
        },
      },
    });
    map.allocate('C', 'S1');
    assert.equal(map.flush(), false);
    assert.ok(logs.some((l) => l.includes('disque plein')));
    assert.equal(map.get('C', 'S1'), 1, 'toujours en memoire');
    fail = false;
    clock.t += 1500;
    map.tick();
    assert.equal(JSON.parse(readFileSync(join(dir, SLOTS_FILE), 'utf8')).controllers.C.S1, 1);
  });

  it('coupure entre l\'ecriture et le renommage : l\'ancien fichier reste intact', () => {
    const dir = tmp();
    const first = mkSlots({ dir }).map;
    first.allocate('C', 'S1');
    first.flush();
    const crashing = mkSlots({
      dir,
      io: {
        write: (file, data) => writeFileSync(file, data),
        rename: () => {
          throw new Error('coupure');
        },
      },
    }).map;
    crashing.allocate('C', 'S2');
    assert.equal(crashing.flush(), false);
    const reread = mkSlots({ dir }).map;
    assert.deepEqual(reread.list('C'), [{ ref: 'S1', slot: 1 }]);
  });

  it('fichier corrompu, vide, tronque, trop gros, au mauvais format : etat vide + avertissement, jamais d\'exception', () => {
    const cases: Array<[string, string]> = [
      ['garbage', '\u0000\u0001 pas du json'],
      ['vide', ''],
      ['espaces', '   \n'],
      ['tronque', '{"v":1,"controllers":{"CTL-1":{"S1":1'],
      ['tableau', '[1,2,3]'],
      ['nombre', '42'],
      ['null', 'null'],
      ['sans controllers', '{"v":1}'],
      ['controllers tableau', '{"v":1,"controllers":[]}'],
      ['controllers texte', '{"v":1,"controllers":"x"}'],
      ['gros', ' '.repeat(1024 * 1024 + 10) + '{}'],
    ];
    for (const [name, content] of cases) {
      const dir = tmp();
      writeFileSync(join(dir, SLOTS_FILE), content);
      const { map, logs } = mkSlots({ dir });
      assert.equal(map.list('CTL-1').length, 0, name);
      assert.equal(map.allocate('CTL-1', 'S1'), 1, name);
      if (name !== 'espaces') assert.ok(logs.length >= 1, `${name} : avertissement`);
    }
  });

  it('fichier avec BOM : lu normalement', () => {
    const dir = tmp();
    writeFileSync(join(dir, SLOTS_FILE), `${cp(0xfeff)}${JSON.stringify({ v: 1, controllers: { C: { S1: 3 } } })}`);
    assert.equal(mkSlots({ dir }).map.get('C', 'S1'), 3);
  });

  it('entrees hostiles dans le fichier : seules les valides sont gardees, jamais deux references sur un meme numero', () => {
    const dir = tmp();
    writeFileSync(
      join(dir, SLOTS_FILE),
      JSON.stringify({
        v: 1,
        controllers: {
          good: { S1: 2, S2: 3 },
          'bad id': { S1: 1 },
          arr: [1, 2],
          nul: null,
          dup: { S1: 1, S2: 1, S3: 2 },
          bad: { S1: -1, S2: 1.5, S3: '2', S4: null, S5: 1e300, s6: 1, H7: 4, S8: 4, Sx: {} },
          toolong: { ['S' + 'a'.repeat(40)]: 1 },
        },
      }),
    );
    const { map, logs } = mkSlots({ dir });
    assert.deepEqual(map.list('good'), [{ ref: 'S1', slot: 2 }, { ref: 'S2', slot: 3 }]);
    assert.deepEqual(map.list('dup'), [{ ref: 'S1', slot: 1 }, { ref: 'S3', slot: 2 }], 'la premiere gagne');
    assert.deepEqual(map.list('bad'), [{ ref: 'S8', slot: 4 }]);
    assert.equal(map.list('toolong').length, 0);
    assert.equal(map.list('bad id').length, 0);
    assert.ok(logs.some((l) => l.includes('invalide')));
  });

  it('identifiant de controleur __proto__ dans le fichier : traite comme une donnee, jamais le prototype', () => {
    const dir = tmp();
    writeFileSync(join(dir, SLOTS_FILE), '{"v":1,"controllers":{"__proto__":{"S1":2},"C":{"S1":1}}}');
    const { map } = mkSlots({ dir });
    assert.equal(map.get('__proto__', 'S1'), 2);
    assert.equal(map.get('C', 'S1'), 1);
    assert.equal(({} as Record<string, unknown>).S1, undefined, 'Object.prototype intact');
    map.allocate('__proto__', 'S2');
    map.flush();
    const written = readFileSync(join(dir, SLOTS_FILE), 'utf8');
    assert.ok(written.includes('"__proto__"'));
    assert.equal(mkSlots({ dir }).map.get('__proto__', 'S2'), 1);
  });

  it('numero hors des bornes (borne reduite apres coup) : conserve, et jamais reattribue a une autre reference', () => {
    const dir = tmp();
    writeFileSync(join(dir, SLOTS_FILE), JSON.stringify({ v: 1, controllers: { C: { S1: 9, S2: 1 } } }));
    const { map } = mkSlots({ dir, min: 1, max: 2 });
    assert.equal(map.get('C', 'S1'), 9);
    assert.equal(map.allocate('C', 'S3'), 2);
    assert.equal(map.allocate('C', 'S4'), 'full');
  });

  it('deux magasins sur le meme dossier : chacun ne remplace que ses controleurs (fusion a l\'ecriture)', () => {
    const dir = tmp();
    const a = mkSlots({ dir }).map;
    const b = mkSlots({ dir }).map;
    a.allocate('CTL-A', 'S1');
    b.allocate('CTL-B', 'S1');
    b.allocate('CTL-B', 'S2');
    a.flush();
    b.flush();
    a.allocate('CTL-A', 'S2');
    a.flush();
    const c = mkSlots({ dir }).map;
    assert.deepEqual(c.list('CTL-A'), [{ ref: 'S1', slot: 1 }, { ref: 'S2', slot: 2 }]);
    assert.deepEqual(c.list('CTL-B'), [{ ref: 'S1', slot: 1 }, { ref: 'S2', slot: 2 }]);
    // liberer toutes les plages d'un controleur le vide dans le fichier
    b.release('CTL-B', 'S1');
    b.release('CTL-B', 'S2');
    b.flush();
    const d = mkSlots({ dir }).map;
    assert.equal(d.list('CTL-B').length, 0);
    assert.equal(d.list('CTL-A').length, 2);
  });

  it('dossier inexistant : cree ; dossier impossible : avertissement, la memoire continue de servir', () => {
    const base = tmp();
    const nested = join(base, 'a', 'b');
    const { map } = mkSlots({ dir: nested });
    map.allocate('C', 'S1');
    assert.equal(map.flush(), true);
    assert.ok(existsSync(join(nested, SLOTS_FILE)));
    // un fichier occupe la place du dossier
    const blocked = join(base, 'bloque');
    writeFileSync(blocked, 'x');
    const { map: m2, logs } = mkSlots({ dir: join(blocked, 'sous') });
    assert.ok(logs.some((l) => l.includes('inutilisable')));
    assert.equal(m2.allocate('C', 'S1'), 1);
    assert.equal(m2.flush(), false);
  });

  it('aucune reference n\'apparait en clair dans les journaux', () => {
    const { map, logs } = mkSlots();
    map.allocate('C', 'S-secret-ref');
    map.allocate('C', 's-minuscule');
    assert.ok(logs.every((l) => !l.includes('secret')));
  });
});

// ---------------------------------------------------------------------------------------------------------------------
interface Call {
  m: string;
  args: unknown[];
}

function fakeDriver(over: Partial<SyncDriver> = {}) {
  const calls: Call[] = [];
  const driver: SyncDriver = {
    upsertHolder: async (...args) => void calls.push({ m: 'upsertHolder', args }),
    deleteHolder: async (...args) => void calls.push({ m: 'deleteHolder', args }),
    upsertSchedule: async (...args) => void calls.push({ m: 'upsertSchedule', args }),
    deleteSchedule: async (...args) => void calls.push({ m: 'deleteSchedule', args }),
    setHolidays: async (...args) => void calls.push({ m: 'setHolidays', args }),
    ...over,
  };
  return { driver, calls };
}

function rig(over: { driver?: Partial<SyncDriver>; min?: number; max?: number; dir?: string; maxQueue?: number; controllerId?: string } = {}) {
  const logs: Array<{ level: string; text: string }> = [];
  const clock = { t: T0 };
  const log = (level: string, text: string): void => void logs.push({ level, text });
  const dir = over.dir ?? tmp();
  const slots = new SlotMap({ dir, now: () => clock.t, log, min: over.min ?? 1, max: over.max ?? 3 });
  const { driver, calls } = fakeDriver(over.driver);
  const handler = makeSyncHandler(over.controllerId ?? 'CTL-1', driver, { slots, now: () => clock.t, log, maxQueue: over.maxQueue });
  return { handler, slots, driver, calls, logs, clock, dir };
}

describe('acces-sync : makeSyncHandler - validation', () => {
  it('identifiant de controleur invalide : RangeError', () => {
    const { driver } = fakeDriver();
    const slots = new SlotMap({ dir: tmp(), now: () => T0, log: () => undefined, min: 1, max: 2 });
    for (const id of ['', 'a b', 'C'.repeat(33), 5 as never, '../x']) assert.throws(() => makeSyncHandler(id, driver, { slots }), RangeError);
  });

  it('ordre invalide : refused / invalid, le controleur n\'est jamais appele', async () => {
    const { handler, calls } = rig();
    const hostile: unknown[] = [
      null,
      undefined,
      5,
      'x',
      [],
      {},
      op({ type: 'drop' }),
      op({ ...holderBody(), pin: '1234' }),
      op(holderBody({ name: '' })),
      op(holderBody({ credentials: ['a', 'a'] })),
      op(scheduleBody({ windows: [] })),
      op({ type: 'set_holidays', dates: ['2026-02-30'] }),
      op({ type: 'delete_holder', holderRef: 'S1' }),
      { ...holderBody(), seq: -1 },
    ];
    for (const raw of hostile) {
      assert.deepEqual(await handler(raw as AccessSyncOp), { result: 'refused', code: 'invalid' }, safe(raw));
    }
    assert.equal(calls.length, 0);
  });

  it('ne rejette jamais, meme avec un objet piege', async () => {
    const { handler, calls } = rig();
    const getter = Object.defineProperty({}, 'type', {
      enumerable: true,
      get() {
        throw new Error('boom');
      },
    });
    assert.deepEqual(await handler(getter as unknown as AccessSyncOp), { result: 'refused', code: 'invalid' });
    const proxy = new Proxy({}, { ownKeys: () => { throw new Error('boom'); } });
    const out = await handler(proxy as unknown as AccessSyncOp);
    assert.ok(out.result === 'refused' || out.result === 'error');
    assert.equal(calls.length, 0);
  });

  it('aucun PIN / gabarit / photo ne peut atteindre le pilote', async () => {
    const { handler, calls } = rig();
    for (const field of ['pin', 'password', 'template', 'photo', 'face', 'fingerprint']) {
      assert.equal((await handler(op({ ...holderBody(), [field]: 'secret-9876' }))).result, 'refused');
    }
    assert.equal(calls.length, 0);
  });
});

describe('acces-sync : makeSyncHandler - plages horaires', () => {
  it('upsert_schedule : attribue la plus petite plage, appelle le controleur, persiste', async () => {
    const { handler, calls, slots, dir } = rig();
    assert.deepEqual(await handler(op(scheduleBody())), { result: 'done' });
    assert.deepEqual(calls, [{ m: 'upsertSchedule', args: ['S1', 1, [{ days: [1, 2, 3, 4, 5], from: '08:00', to: '17:00' }], true] }]);
    assert.equal(slots.get('CTL-1', 'S1'), 1);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, SLOTS_FILE), 'utf8')).controllers['CTL-1'], { S1: 1 });
    assert.deepEqual(await handler(op(scheduleBody({ scheduleRef: 'S2', holidays: false }), 2)), { result: 'done' });
    assert.equal(calls[1]!.args[1], 2);
    assert.equal(calls[1]!.args[3], false);
  });

  it('rejouer deux fois le meme upsert : done deux fois, meme plage, aucun effet de bord', async () => {
    const { handler, calls, slots } = rig();
    assert.deepEqual(await handler(op(scheduleBody(), 1)), { result: 'done' });
    assert.deepEqual(await handler(op(scheduleBody(), 1)), { result: 'done' });
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0], calls[1]);
    assert.deepEqual(slots.list('CTL-1'), [{ ref: 'S1', slot: 1 }]);
  });

  it('capacite : plus de numero libre = refused / full, SANS appeler le controleur ; deja connue = toujours servie', async () => {
    const { handler, calls, slots } = rig({ max: 2 });
    await handler(op(scheduleBody({ scheduleRef: 'S1' })));
    await handler(op(scheduleBody({ scheduleRef: 'S2' })));
    calls.length = 0;
    assert.deepEqual(await handler(op(scheduleBody({ scheduleRef: 'S3' }))), { result: 'refused', code: 'full' });
    assert.equal(calls.length, 0);
    assert.equal(slots.get('CTL-1', 'S3'), null);
    assert.deepEqual(await handler(op(scheduleBody({ scheduleRef: 'S1', holidays: false }))), { result: 'done' });
    assert.equal(calls.length, 1);
    // liberer une plage permet de nouveau d'en creer une
    assert.deepEqual(await handler(op({ type: 'delete_schedule', scheduleRef: 'S2' })), { result: 'done' });
    assert.deepEqual(await handler(op(scheduleBody({ scheduleRef: 'S3' }))), { result: 'done' });
    assert.equal(slots.get('CTL-1', 'S3'), 2);
  });

  it('echec du controleur sur une NOUVELLE plage : aucune attribution fantome (memoire et disque)', async () => {
    const codes = ['io', 'unreachable', 'timeout', 'busy'];
    for (const code of codes) {
      const { handler, slots, dir } = rig({ driver: { upsertSchedule: async () => { throw new ActuatorFailure(code, 'detail'); } } });
      assert.deepEqual(await handler(op(scheduleBody())), { result: 'error', code });
      assert.equal(slots.get('CTL-1', 'S1'), null, code);
      assert.deepEqual(slots.list('CTL-1'), []);
      slots.flush();
      const onDisk = existsSync(join(dir, SLOTS_FILE)) ? JSON.parse(readFileSync(join(dir, SLOTS_FILE), 'utf8')).controllers : {};
      assert.deepEqual(onDisk['CTL-1'] ?? {}, {}, code);
    }
  });

  it("echec du controleur sur une plage DEJA connue : l'attribution existante est conservee", async () => {
    let fail = false;
    const { handler, slots } = rig({ driver: { upsertSchedule: async () => { if (fail) throw new ActuatorFailure('io', 'x'); } } });
    await handler(op(scheduleBody()));
    fail = true;
    assert.deepEqual(await handler(op(scheduleBody({ holidays: false }))), { result: 'error', code: 'io' });
    assert.equal(slots.get('CTL-1', 'S1'), 1);
    fail = false;
    assert.deepEqual(await handler(op(scheduleBody())), { result: 'done' });
    assert.deepEqual(slots.list('CTL-1'), [{ ref: 'S1', slot: 1 }]);
  });

  it('apres un echec, le numero est de nouveau libre pour une autre plage', async () => {
    let fail = true;
    const { handler, slots } = rig({ max: 1, driver: { upsertSchedule: async () => { if (fail) throw new ActuatorFailure('timeout', 'x'); } } });
    assert.equal((await handler(op(scheduleBody({ scheduleRef: 'S1' })))).result, 'error');
    fail = false;
    assert.deepEqual(await handler(op(scheduleBody({ scheduleRef: 'S2' }))), { result: 'done' });
    assert.equal(slots.get('CTL-1', 'S2'), 1);
  });

  it('delete_schedule : appelle le controleur avec la plage, libere apres confirmation', async () => {
    const { handler, calls, slots } = rig();
    await handler(op(scheduleBody()));
    calls.length = 0;
    assert.deepEqual(await handler(op({ type: 'delete_schedule', scheduleRef: 'S1' })), { result: 'done' });
    assert.deepEqual(calls, [{ m: 'deleteSchedule', args: ['S1', 1] }]);
    assert.equal(slots.get('CTL-1', 'S1'), null);
  });

  it('delete_schedule en echec : l\'attribution est conservee', async () => {
    let fail = true;
    const { handler, slots } = rig({ driver: { deleteSchedule: async () => { if (fail) throw new ActuatorFailure('unreachable', 'x'); } } });
    await handler(op(scheduleBody()));
    assert.deepEqual(await handler(op({ type: 'delete_schedule', scheduleRef: 'S1' })), { result: 'error', code: 'unreachable' });
    assert.equal(slots.get('CTL-1', 'S1'), 1);
    fail = false;
    assert.deepEqual(await handler(op({ type: 'delete_schedule', scheduleRef: 'S1' })), { result: 'done' });
    assert.equal(slots.get('CTL-1', 'S1'), null);
  });

  it('delete_schedule d\'une reference inconnue : done, sans appeler le controleur (idempotent)', async () => {
    const { handler, calls } = rig();
    assert.deepEqual(await handler(op({ type: 'delete_schedule', scheduleRef: 'S42' })), { result: 'done' });
    assert.deepEqual(await handler(op({ type: 'delete_schedule', scheduleRef: 'S42' })), { result: 'done' });
    assert.equal(calls.length, 0);
  });

  it("l'attribution survit a un redemarrage (nouveau SlotMap, nouveau gestionnaire)", async () => {
    const first = rig();
    await first.handler(op(scheduleBody({ scheduleRef: 'S1' })));
    await first.handler(op(scheduleBody({ scheduleRef: 'S2' })));
    const second = rig({ dir: first.dir });
    assert.equal(second.slots.get('CTL-1', 'S2'), 2);
    assert.deepEqual(await second.handler(op(holderBody({ doors: [{ doorNo: 2, scheduleRef: 'S2' }] }))), { result: 'done' });
    assert.deepEqual(second.calls[0]!.args[1], [{ doorNo: 2, slot: 2 }]);
    assert.deepEqual(await second.handler(op(scheduleBody({ scheduleRef: 'S3' }))), { result: 'done' });
    assert.equal(second.slots.get('CTL-1', 'S3'), 3);
  });

  it('un disque qui refuse l\'ecriture ne change pas la reponse (avertissement, retente plus tard)', async () => {
    const logs: string[] = [];
    const clock = { t: T0 };
    const slots = new SlotMap({
      dir: tmp(),
      now: () => clock.t,
      log: (_l, t) => void logs.push(t),
      min: 1,
      max: 3,
      io: { write: () => { throw new Error('lecture seule'); } },
    });
    const { driver } = fakeDriver();
    const handler = makeSyncHandler('CTL-1', driver, { slots, now: () => clock.t, log: (_l, t) => void logs.push(t) });
    assert.deepEqual(await handler(op(scheduleBody())), { result: 'done' });
    assert.ok(logs.some((l) => l.includes('non ecrite')));
    assert.equal(slots.get('CTL-1', 'S1'), 1);
  });
});

describe('acces-sync : makeSyncHandler - titulaires, jours feries', () => {
  it('upsert_holder : le pilote recoit le titulaire sans "type" ni secret, et les plages de ses portes', async () => {
    const { handler, calls } = rig();
    await handler(op(scheduleBody({ scheduleRef: 'S1' })));
    await handler(op(scheduleBody({ scheduleRef: 'S2' })));
    calls.length = 0;
    const body = holderBody({ validFrom: T0, validTo: T0 + 1000, credentials: ['111', '222'], doors: [{ doorNo: 1, scheduleRef: 'S2' }, { doorNo: 3, scheduleRef: null }, { doorNo: 2, scheduleRef: 'S1' }] });
    assert.deepEqual(await handler(op(body, 5)), { result: 'done' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.m, 'upsertHolder');
    assert.deepEqual(calls[0]!.args[0], {
      holderRef: 'H101',
      name: 'KONAN Yao',
      active: true,
      validFrom: T0,
      validTo: T0 + 1000,
      credentials: ['111', '222'],
      doors: [{ doorNo: 1, scheduleRef: 'S2' }, { doorNo: 3, scheduleRef: null }, { doorNo: 2, scheduleRef: 'S1' }],
    });
    assert.deepEqual(calls[0]!.args[1], [{ doorNo: 1, slot: 2 }, { doorNo: 3, slot: null }, { doorNo: 2, slot: 1 }]);
    assert.equal(Object.hasOwn(calls[0]!.args[0] as object, 'opId'), false);
    assert.equal(Object.hasOwn(calls[0]!.args[0] as object, 'seq'), false);
  });

  it('upsert_holder avec un horaire inconnu : refused / invalid, le controleur n\'est pas appele', async () => {
    const { handler, calls } = rig();
    assert.deepEqual(await handler(op(holderBody({ doors: [{ doorNo: 1, scheduleRef: 'S9' }] }))), { result: 'refused', code: 'invalid' });
    assert.equal(calls.length, 0);
    // un horaire dont la creation a echoue n'est pas connu non plus
    const bad = rig({ driver: { upsertSchedule: async () => { throw new ActuatorFailure('io', 'x'); } } });
    await bad.handler(op(scheduleBody()));
    assert.deepEqual(await bad.handler(op(holderBody({ doors: [{ doorNo: 1, scheduleRef: 'S1' }] }))), { result: 'refused', code: 'invalid' });
  });

  it('upsert_holder sans porte, ou toutes les heures (null)', async () => {
    const { handler, calls } = rig();
    assert.deepEqual(await handler(op(holderBody({ doors: [] }))), { result: 'done' });
    assert.deepEqual(calls[0]!.args[1], []);
    assert.deepEqual(await handler(op(holderBody({ doors: [{ doorNo: 4, scheduleRef: null }] }))), { result: 'done' });
    assert.deepEqual(calls[1]!.args[1], [{ doorNo: 4, slot: null }]);
  });

  it('rejouer deux fois le meme upsert_holder : done deux fois, memes arguments', async () => {
    const { handler, calls } = rig();
    const o = op(holderBody());
    assert.deepEqual(await handler(o), { result: 'done' });
    assert.deepEqual(await handler(o), { result: 'done' });
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0], calls[1]);
  });

  it('delete_holder et set_holidays : transmis tels quels', async () => {
    const { handler, calls } = rig();
    assert.deepEqual(await handler(op({ type: 'delete_holder', holderRef: 'H55' })), { result: 'done' });
    assert.deepEqual(await handler(op({ type: 'set_holidays', dates: ['2026-12-25'], replace: true })), { result: 'done' });
    assert.deepEqual(await handler(op({ type: 'set_holidays', dates: ['2026-01-01'] })), { result: 'done' });
    assert.deepEqual(calls, [
      { m: 'deleteHolder', args: ['H55'] },
      { m: 'setHolidays', args: [['2026-12-25'], true] },
      { m: 'setHolidays', args: [['2026-01-01'], false] },
    ]);
  });

  it('echecs du controleur sur un titulaire : traduits, rien d\'autre ne change', async () => {
    const { handler, slots } = rig({ driver: { upsertHolder: async () => { throw new ActuatorFailure('io', 'x'); }, deleteHolder: async () => { throw new ActuatorFailure('timeout', 'x'); }, setHolidays: async () => { throw new ActuatorFailure('unreachable', 'x'); } } });
    assert.deepEqual(await handler(op(holderBody())), { result: 'error', code: 'io' });
    assert.deepEqual(await handler(op({ type: 'delete_holder', holderRef: 'H1' })), { result: 'error', code: 'timeout' });
    assert.deepEqual(await handler(op({ type: 'set_holidays', dates: [] })), { result: 'error', code: 'unreachable' });
    assert.deepEqual(slots.list('CTL-1'), []);
  });
});

describe('acces-sync : makeSyncHandler - traduction des echecs', () => {
  it('not_supported / invalid / full du pilote = refused ; le reste = error', async () => {
    for (const code of ['not_supported', 'invalid', 'full']) {
      const { handler } = rig({ driver: { deleteHolder: async () => { throw new ActuatorFailure(code, 'x'); } } });
      assert.deepEqual(await handler(op({ type: 'delete_holder', holderRef: 'H1' })), { result: 'refused', code }, code);
    }
    for (const code of ['io', 'unreachable', 'timeout', 'busy', 'auth', 'x1']) {
      const { handler } = rig({ driver: { deleteHolder: async () => { throw new ActuatorFailure(code, 'x'); } } });
      assert.deepEqual(await handler(op({ type: 'delete_holder', holderRef: 'H1' })), { result: 'error', code }, code);
    }
  });

  it('refus du pilote sur une nouvelle plage : attribution annulee aussi', async () => {
    const { handler, slots } = rig({ driver: { upsertSchedule: async () => { throw new ActuatorFailure('not_supported', 'x'); } } });
    assert.deepEqual(await handler(op(scheduleBody())), { result: 'refused', code: 'not_supported' });
    assert.equal(slots.get('CTL-1', 'S1'), null);
  });

  it('code mal forme, exception ordinaire, valeur jetee, exception synchrone : error / io', async () => {
    const throwers: Array<() => Promise<void>> = [
      async () => { throw new ActuatorFailure('Code Avec Espaces', 'x'); },
      async () => { throw new ActuatorFailure('', 'x'); },
      async () => { throw new ActuatorFailure('x'.repeat(40), 'x'); },
      async () => { throw new TypeError('inattendu'); },
      async () => { throw 'une chaine'; },
      async () => { throw null; },
      async () => { throw undefined; },
      () => { throw new Error('synchrone'); },
      () => Promise.reject(new Error('rejet')),
    ];
    for (const thrower of throwers) {
      const { handler, slots } = rig({ driver: { upsertSchedule: thrower, deleteHolder: thrower } });
      assert.deepEqual(await handler(op({ type: 'delete_holder', holderRef: 'H1' })), { result: 'error', code: 'io' });
      assert.deepEqual(await handler(op(scheduleBody())), { result: 'error', code: 'io' });
      assert.equal(slots.get('CTL-1', 'S1'), null);
    }
  });

  it('methode absente du pilote : refused / not_supported, rien d\'alloue', async () => {
    const { handler, slots, calls } = rig({ driver: { upsertSchedule: undefined as never, setHolidays: undefined as never } });
    assert.deepEqual(await handler(op(scheduleBody())), { result: 'refused', code: 'not_supported' });
    assert.deepEqual(await handler(op({ type: 'set_holidays', dates: [] })), { result: 'refused', code: 'not_supported' });
    assert.equal(slots.get('CTL-1', 'S1'), null);
    assert.equal(calls.length, 0);
    assert.deepEqual(await handler(op({ type: 'delete_holder', holderRef: 'H1' })), { result: 'done' });
  });

  it('un journal qui leve ne change pas la reponse', async () => {
    const slots = new SlotMap({ dir: tmp(), now: () => T0, log: () => undefined, min: 1, max: 2 });
    const { driver } = fakeDriver({ deleteHolder: async () => { throw new Error('x'); } });
    const handler = makeSyncHandler('CTL-1', driver, { slots, log: () => { throw new Error('journal casse'); } });
    assert.deepEqual(await handler(op({ type: 'delete_holder', holderRef: 'H1' })), { result: 'error', code: 'io' });
    assert.deepEqual(await handler(op({ type: 'drop' } as never)), { result: 'refused', code: 'invalid' });
  });
});

describe('acces-sync : makeSyncHandler - serialisation et file bornee', () => {
  /** Pilote dont chaque appel attend qu'on le libere ; suit la concurrence maximale observee. */
  function gated() {
    const log: string[] = [];
    let running = 0;
    let max = 0;
    const gates: Array<() => void> = [];
    const wait = (label: string, fail?: ActuatorFailure) => async (): Promise<void> => {
      running++;
      max = Math.max(max, running);
      log.push(`debut ${label}`);
      await new Promise<void>((resolve) => gates.push(resolve));
      running--;
      log.push(`fin ${label}`);
      if (fail) throw fail;
    };
    return { log, gates, maxConcurrent: () => max, wait };
  }
  const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

  it('deux operations simultanees sont executees une a la fois, dans l\'ordre d\'arrivee', async () => {
    const g = gated();
    let n = 0;
    const { handler } = rig({
      driver: {
        deleteHolder: async (ref) => {
          await g.wait(`deleteHolder:${ref}`)();
          n++;
        },
        setHolidays: g.wait('setHolidays'),
      },
    });
    const p1 = handler(op({ type: 'delete_holder', holderRef: 'H1' }, 1));
    const p2 = handler(op({ type: 'set_holidays', dates: [] }, 2));
    const p3 = handler(op({ type: 'delete_holder', holderRef: 'H3' }, 3));
    await tick();
    assert.deepEqual(g.log, ['debut deleteHolder:H1'], 'seule la premiere a commence');
    g.gates.shift()!();
    await tick();
    await tick();
    assert.deepEqual(g.log, ['debut deleteHolder:H1', 'fin deleteHolder:H1', 'debut setHolidays']);
    g.gates.shift()!();
    await tick();
    await tick();
    g.gates.shift()!();
    const results = await Promise.all([p1, p2, p3]);
    assert.deepEqual(results, [{ result: 'done' }, { result: 'done' }, { result: 'done' }]);
    assert.deepEqual(g.log, ['debut deleteHolder:H1', 'fin deleteHolder:H1', 'debut setHolidays', 'fin setHolidays', 'debut deleteHolder:H3', 'fin deleteHolder:H3']);
    assert.equal(g.maxConcurrent(), 1);
    assert.equal(n, 2);
  });

  it('une operation en echec ne bloque pas la suivante', async () => {
    const g = gated();
    const { handler } = rig({ driver: { deleteHolder: g.wait('a', new ActuatorFailure('io', 'x')), setHolidays: g.wait('b') } });
    const p1 = handler(op({ type: 'delete_holder', holderRef: 'H1' }, 1));
    const p2 = handler(op({ type: 'set_holidays', dates: [] }, 2));
    await tick();
    g.gates.shift()!();
    await tick();
    await tick();
    g.gates.shift()!();
    assert.deepEqual(await p1, { result: 'error', code: 'io' });
    assert.deepEqual(await p2, { result: 'done' });
  });

  it('attributions concurrentes de deux plages : numeros distincts, aucune course', async () => {
    const g = gated();
    const { handler, slots } = rig({ driver: { upsertSchedule: async (ref) => { await g.wait(ref)(); } } });
    const p1 = handler(op(scheduleBody({ scheduleRef: 'S1' }), 1));
    const p2 = handler(op(scheduleBody({ scheduleRef: 'S2' }), 2));
    await tick();
    assert.equal(slots.get('CTL-1', 'S2'), null, 'la seconde n\'est pas encore traitee');
    g.gates.shift()!();
    await tick();
    await tick();
    g.gates.shift()!();
    await Promise.all([p1, p2]);
    assert.deepEqual(slots.list('CTL-1'), [{ ref: 'S1', slot: 1 }, { ref: 'S2', slot: 2 }]);
  });

  it('un upsert en echec puis un autre : le numero rendu est reutilise sans trou', async () => {
    const g = gated();
    const { handler, slots } = rig({ driver: { upsertSchedule: async (ref) => { await g.wait(ref, ref === 'S1' ? new ActuatorFailure('io', 'x') : undefined)(); } } });
    const p1 = handler(op(scheduleBody({ scheduleRef: 'S1' }), 1));
    const p2 = handler(op(scheduleBody({ scheduleRef: 'S2' }), 2));
    await tick();
    g.gates.shift()!();
    await tick();
    await tick();
    g.gates.shift()!();
    assert.equal((await p1).result, 'error');
    assert.equal((await p2).result, 'done');
    assert.deepEqual(slots.list('CTL-1'), [{ ref: 'S2', slot: 1 }]);
  });

  it('file bornee : au-dela de maxQueue, error / busy immediatement ; la place revient quand une operation se termine', async () => {
    const g = gated();
    const { handler } = rig({ maxQueue: 2, driver: { deleteHolder: async () => { await g.wait('x')(); } } });
    const o = (seq: number) => op({ type: 'delete_holder', holderRef: `H${seq}` }, seq);
    const p1 = handler(o(1));
    const p2 = handler(o(2));
    assert.deepEqual(await handler(o(3)), { result: 'error', code: 'busy' });
    // un ordre invalide est refuse tout de suite meme quand la file est pleine
    assert.deepEqual(await handler(op({ type: 'drop' } as never)), { result: 'refused', code: 'invalid' });
    g.gates.shift()!();
    await p1;
    const p4 = handler(o(4));
    assert.deepEqual(await handler(o(5)), { result: 'error', code: 'busy' });
    await tick();
    g.gates.shift()!();
    await tick();
    await tick();
    g.gates.shift()!();
    assert.deepEqual(await Promise.all([p2, p4]), [{ result: 'done' }, { result: 'done' }]);
    assert.equal(g.maxConcurrent(), 1);
    // la file est de nouveau vide
    const p6 = handler(o(6));
    await tick();
    g.gates.shift()!();
    assert.deepEqual(await p6, { result: 'done' });
  });

  it('les gestionnaires de deux controleurs sont independants (un controleur bloque ne retient pas l\'autre)', async () => {
    const g = gated();
    const slots = new SlotMap({ dir: tmp(), now: () => T0, log: () => undefined, min: 1, max: 4 });
    const slow = makeSyncHandler('CTL-A', fakeDriver({ deleteHolder: g.wait('A') }).driver, { slots });
    const fast = makeSyncHandler('CTL-B', fakeDriver().driver, { slots });
    const pa = slow(op({ type: 'delete_holder', holderRef: 'H1' }));
    assert.deepEqual(await fast(op({ type: 'delete_holder', holderRef: 'H1' })), { result: 'done' });
    g.gates.shift()!();
    assert.deepEqual(await pa, { result: 'done' });
    // les tables de plages sont separees par controleur
    await slow(op(scheduleBody()));
    await fast(op(scheduleBody()));
    assert.equal(slots.get('CTL-A', 'S1'), 1);
    assert.equal(slots.get('CTL-B', 'S1'), 1);
  });
});

describe('acces-sync : makeSyncHandler - journaux', () => {
  it('ni nom, ni numero de badge, ni reference de titulaire, ni reference d\'horaire dans les journaux', async () => {
    const { handler, logs } = rig({
      driver: {
        upsertHolder: async () => { throw new ActuatorFailure('io', 'echec pour KONAN Yao badge 0012345 H101'); },
        deleteHolder: async () => { throw new Error('H101 introuvable'); },
      },
    });
    await handler(op(holderBody({ name: 'KONAN Yao', credentials: ['0012345'], holderRef: 'H101' })));
    await handler(op({ type: 'delete_holder', holderRef: 'H101' }));
    await handler(op(scheduleBody({ scheduleRef: 'S-RH-77' })));
    await handler(op(holderBody({ holderRef: 'H101', name: 'KONAN Yao', doors: [{ doorNo: 1, scheduleRef: 'S-RH-99' }] })));
    await handler(op({ ...holderBody({ name: 'SECRET Nom' }), pin: '9876', holderRef: 'H-secret' } as never));
    assert.ok(logs.length > 0);
    const all = logs.map((l) => l.text).join('\n');
    for (const forbidden of ['KONAN', 'Yao', '0012345', 'H101', 'S-RH-77', 'S-RH-99', 'SECRET', '9876', 'H-secret', 'introuvable']) {
      assert.ok(!all.includes(forbidden), `journal : ${forbidden}`);
    }
    for (const l of logs) assert.ok(!/[\r\n]/.test(l.text) && l.text.length <= 400);
  });

  it('une synchronisation reussie est journalisee en info, un echec en avertissement, avec l\'identifiant d\'ordre abrege', async () => {
    const { handler, logs } = rig({ driver: { deleteHolder: async () => { throw new ActuatorFailure('timeout', 'x'); } } });
    await handler(op({ type: 'set_holidays', dates: [] }));
    await handler(op({ type: 'delete_holder', holderRef: 'H1' }));
    assert.equal(logs[0]!.level, 'info');
    assert.match(logs[0]!.text, /set_holidays -> done/);
    assert.equal(logs[1]!.level, 'warn');
    assert.match(logs[1]!.text, /delete_holder -> error \(timeout\)/);
    assert.ok(logs[1]!.text.includes(OPID.slice(0, 8)));
    assert.ok(!logs[1]!.text.includes(OPID));
  });

  it("un reseau bavard n'inonde pas le journal (ordres invalides repetes)", async () => {
    const { handler, logs } = rig();
    for (let i = 0; i < 200; i++) await handler(op({ type: 'drop' } as never));
    assert.ok(logs.length <= 2, `${logs.length} lignes`);
  });
});
