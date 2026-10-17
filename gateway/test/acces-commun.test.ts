/**
 * Essais du code commun des modules de controle d'acces (gateway/src/modules/acces-commun/) : messages, compteur de refus,
 * curseurs, superviseur de controleur. Horloge injectee, aucun reseau, aucun temporisateur reel ; les curseurs utilisent un
 * dossier temporaire.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync as renameSyncReal, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { MODULES_DIR, moduleEntry } from '../src/config.ts';
import type { DeviceMessage } from '../src/module.ts';
import {
  ControllerSupervisor,
  CursorStore,
  DenialCounter,
  CURSOR_FILE,
  cleanCredential,
  cleanEventId,
  cleanRef,
  cleanText,
  createLimitedLog,
  defaultCursorCompare,
  doorEventMessage,
  emitted,
  passageMessage,
  validTs,
} from '../src/modules/acces-commun/commun.ts';
import type { CursorIo, DoorEventKind, PartialThresholds, PassageInput } from '../src/modules/acces-commun/commun.ts';
import { MSG_ID, prepare } from '../src/validate.ts';

const T0 = 1_760_000_000_000;
const SEC = 1000;
const cp = (...codes: number[]): string => String.fromCodePoint(...codes);
const EMOJI = cp(0x1f600);

const tmpDirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'acces-commun-'));
  tmpDirs.push(d);
  return d;
}
after(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

function passage(over: Partial<PassageInput> = {}): PassageInput {
  return {
    doorNo: 1,
    ts: T0,
    eventId: '123456',
    direction: 'in',
    credential: '0012345',
    holderName: 'KONAN Yao',
    holderRef: '101',
    method: 'badge',
    result: 'granted',
    reason: null,
    deferred: false,
    ...over,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
describe('acces-commun : nettoyage des textes venus du controleur', () => {
  it('cleanText : entrees hostiles (objets, tableaux, booleens, nombres non finis) = null, sans exception', () => {
    for (const bad of [{}, { toString: () => 'x' }, [], ['a'], null, undefined, true, false, Number.NaN, Infinity, -Infinity, () => 'a', Symbol('s')]) {
      assert.equal(cleanText(bad, 64), null, String(typeof bad));
    }
    assert.equal(cleanText('abc', 0), null);
    assert.equal(cleanText('abc', Number.NaN), null);
    assert.equal(cleanText('abc', -3), null);
  });

  it('cleanText : nombres et entiers longs acceptes comme texte', () => {
    assert.equal(cleanText(12345, 64), '12345');
    assert.equal(cleanText(10n ** 20n, 64), '100000000000000000000');
  });

  it('cleanText : caracteres de controle, espaces multiples, bords', () => {
    assert.equal(cleanText('  KONAN \t\r\n  Yao  ', 64), 'KONAN Yao');
    assert.equal(cleanText('a' + cp(0, 1, 7, 0x1b, 0x7f) + 'b', 64), 'a b');
    assert.equal(cleanText('   \n\t  ', 64), null);
    assert.equal(cleanText('', 64), null);
    assert.equal(cleanText(cp(0x00a0) + 'x' + cp(0x2003, 0x2003) + 'y', 64), 'x y');
    assert.equal(cleanText('ligne1' + cp(0x2028) + 'ligne2', 64), 'ligne1 ligne2');
  });

  it('cleanText : caracteres invisibles (sens de lecture, largeur nulle, BOM) retires', () => {
    assert.equal(cleanText(cp(0x202e) + 'abc' + cp(0x200b, 0x2066, 0xfeff, 0x00ad, 0x2060, 0x200e), 64), 'abc');
  });

  it('cleanText : normalise en NFC', () => {
    assert.equal(cleanText('e' + cp(0x0301), 64), cp(0x00e9));
    assert.equal(cleanText('Ame' + cp(0x0301) + 'lie', 64), 'Am' + cp(0x00e9) + 'lie');
  });

  it('cleanText : borne la longueur sans couper une paire de substitution', () => {
    assert.equal(cleanText('abcdef', 3), 'abc');
    // emoji = 2 unites UTF-16 : a la limite, il part en entier ou pas du tout
    const s = 'ab' + EMOJI + 'cd';
    assert.equal(cleanText(s, 3), 'ab');
    assert.equal(cleanText(s, 4), 'ab' + EMOJI);
    assert.equal(cleanText(s, 5), 'ab' + EMOJI + 'c');
    assert.equal(cleanText(EMOJI, 1), null);
    for (let max = 1; max <= 12; max++) {
      const out = cleanText(EMOJI.repeat(10), max);
      if (out !== null) {
        assert.ok(out.length <= max);
        assert.equal(out, EMOJI.repeat(out.length / 2), 'jamais une moitie d\'emoji');
      }
    }
  });

  it('cleanText : moities de paire isolees retirees', () => {
    assert.equal(cleanText('a' + String.fromCharCode(0xd800) + 'b', 64), 'ab');
    assert.equal(cleanText('a' + String.fromCharCode(0xdc00) + 'b', 64), 'ab');
    assert.equal(cleanText(String.fromCharCode(0xd83d), 64), null);
  });

  it('cleanText : chaine enorme traitee vite et bornee', () => {
    const huge = 'x'.repeat(10_000_000);
    const t = Date.now();
    const out = cleanText(huge, 64);
    assert.equal(out?.length, 64);
    assert.ok(Date.now() - t < 500, 'pas de traitement de 10 Mo');
    assert.equal(cleanText(' '.repeat(5_000_000) + 'abc', 64), null, 'les 4096 premiers caracteres seuls sont lus');
  });

  it('cleanCredential / cleanRef : alphabet [A-Za-z0-9._:-], 32 au plus, null si vide', () => {
    assert.equal(cleanCredential('0012345'), '0012345');
    assert.equal(cleanCredential(' 00 12/34;5 '), '0012345');
    assert.equal(cleanCredential('AB:12.3_4-5'), 'AB:12.3_4-5');
    assert.equal(cleanCredential('x'.repeat(100)), 'x'.repeat(32));
    assert.equal(cleanCredential(cp(0xe9, 0x20ac)), null);
    assert.equal(cleanCredential(''), null);
    assert.equal(cleanCredential({}), null);
    assert.equal(cleanCredential(null), null);
    assert.equal(cleanCredential(12345), '12345');
    assert.equal(cleanCredential('1'.repeat(10_000_000)), '1'.repeat(32));
    assert.equal(cleanRef('101'), '101');
    assert.equal(cleanRef('r<script>1'), 'rscript1');
    assert.equal(cleanRef('y'.repeat(33)), 'y'.repeat(32));
    assert.equal(cleanRef([]), null);
  });

  it('cleanEventId : conforme = inchange ; sinon debut nettoye + empreinte de l\'original (deterministe, distinct)', () => {
    assert.equal(cleanEventId('123456'), '123456');
    assert.equal(cleanEventId('a.b_c:d-e'), 'a.b_c:d-e');
    assert.equal(cleanEventId('x'.repeat(40)), 'x'.repeat(40));
    assert.equal(cleanEventId(''), null);
    assert.equal(cleanEventId({}), null);
    const long = cleanEventId('x'.repeat(41)) as string;
    assert.match(long, /^[A-Za-z0-9._:-]{1,40}$/);
    assert.equal(long.length, 40);
    assert.equal(cleanEventId('x'.repeat(41)), long, 'deterministe');
    assert.notEqual(cleanEventId('x'.repeat(42)), long, 'deux longs identifiants de meme debut restent distincts');
    const a = cleanEventId('12 34') as string;
    const b = cleanEventId('12/34') as string;
    assert.match(a, /^[A-Za-z0-9._:-]{1,40}$/);
    assert.notEqual(a, b);
    assert.match(cleanEventId(cp(0xe9, 0xe8)) as string, /^[A-Za-z0-9._:-]{1,40}$/);
    assert.match(cleanEventId('z'.repeat(1_000_000)) as string, /^[A-Za-z0-9._:-]{1,40}$/);
    assert.equal(cleanEventId(42), '42');
  });

  it('validTs : entier en millisecondes apres 2001', () => {
    assert.equal(validTs(T0), true);
    assert.equal(validTs(1e12), true);
    for (const bad of [0, -1, 1.5, Number.NaN, Infinity, 1_760_000_000, '1760000000000', null, undefined, {}, 2 ** 60]) assert.equal(validTs(bad), false, String(bad));
  });

  it('emitted : seul un false explicite compte comme refus', () => {
    assert.equal(emitted(false), false);
    assert.equal(emitted(true), true);
    assert.equal(emitted(undefined), true);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('acces-commun : message de passage (contrat par. 2)', () => {
  it('format exact, ordre des champs et msgId', () => {
    const msg = passageMessage('CTL-1', passage());
    assert.deepEqual(msg, {
      event: 'badge_granted',
      ts: T0,
      msgId: 'acc:CTL-1:123456',
      access: {
        v: 1,
        controllerId: 'CTL-1',
        eventId: '123456',
        direction: 'in',
        credential: '0012345',
        holderName: 'KONAN Yao',
        holderRef: '101',
        method: 'badge',
        result: 'granted',
        reason: null,
        deferred: false,
      },
    });
    assert.deepEqual(Object.keys(msg), ['event', 'ts', 'msgId', 'access']);
    assert.deepEqual(Object.keys(msg.access!), ['v', 'controllerId', 'eventId', 'direction', 'credential', 'holderName', 'holderRef', 'method', 'result', 'reason', 'deferred']);
  });

  it('refus : badge_denied avec motif ; motif inconnu ou absent = other ; accepte = reason null', () => {
    const d = passageMessage('CTL-1', passage({ result: 'denied', reason: 'expired' }));
    assert.equal(d.event, 'badge_denied');
    assert.equal(d.access?.result, 'denied');
    assert.equal(d.access?.reason, 'expired');
    assert.equal(passageMessage('CTL-1', passage({ result: 'denied', reason: null })).access?.reason, 'other');
    assert.equal(passageMessage('CTL-1', passage({ result: 'denied', reason: 'nimporte' as never })).access?.reason, 'other');
    assert.equal(passageMessage('CTL-1', passage({ result: 'granted', reason: 'expired' })).access?.reason, null);
    for (const reason of ['unknown_credential', 'expired', 'out_of_schedule', 'disabled', 'wrong_pin', 'antipassback', 'door_locked', 'other'] as const) {
      assert.equal(passageMessage('CTL-1', passage({ result: 'denied', reason })).access?.reason, reason);
    }
  });

  it('methodes, sens : valeurs inconnues ramenees a unknown / null', () => {
    for (const method of ['badge', 'code', 'fingerprint', 'face', 'exit_button', 'remote', 'unknown'] as const) {
      assert.equal(passageMessage('CTL-1', passage({ method })).access?.method, method);
    }
    assert.equal(passageMessage('CTL-1', passage({ method: 'telepathie' as never })).access?.method, 'unknown');
    assert.equal(passageMessage('CTL-1', passage({ method: 42 as never })).access?.method, 'unknown');
    assert.equal(passageMessage('CTL-1', passage({ direction: 'out' })).access?.direction, 'out');
    assert.equal(passageMessage('CTL-1', passage({ direction: null })).access?.direction, null);
    assert.equal(passageMessage('CTL-1', passage({ direction: 'sideways' as never })).access?.direction, null);
    assert.equal(passageMessage('CTL-1', passage({ deferred: true })).access?.deferred, true);
    assert.equal(passageMessage('CTL-1', passage({ deferred: 'oui' as never })).access?.deferred, false);
  });

  it('jamais de PIN : methode code = credential null ; aucun champ en plus recopie', () => {
    const m = passageMessage('CTL-1', passage({ method: 'code', credential: '4321' }));
    assert.equal(m.access?.credential, null);
    const extra = { ...passage(), pin: '9876', password: 'secret', template: 'AAAA', cursor: '77' } as PassageInput;
    const json = JSON.stringify(passageMessage('CTL-1', extra));
    for (const s of ['9876', 'secret', 'AAAA', '"cursor"', '"pin"', '"doorNo"']) assert.ok(!json.includes(s), s);
  });

  it('champs optionnels vides ou hostiles = null', () => {
    const m = passageMessage('CTL-1', passage({ credential: null, holderName: null, holderRef: null }));
    assert.equal(m.access?.credential, null);
    assert.equal(m.access?.holderName, null);
    assert.equal(m.access?.holderRef, null);
    const h = passageMessage('CTL-1', passage({ credential: {} as never, holderName: ['x'] as never, holderRef: Number.NaN as never }));
    assert.equal(h.access?.credential, null);
    assert.equal(h.access?.holderName, null);
    assert.equal(h.access?.holderRef, null);
  });

  it('msgId : alphabet du PSIM, 64 au plus, deterministe, distinct par evenement', () => {
    const longCtl = 'C'.repeat(32);
    const longEvt = 'e'.repeat(40);
    const a = passageMessage(longCtl, passage({ eventId: longEvt }));
    assert.match(a.msgId!, MSG_ID);
    assert.ok(a.msgId!.length <= 64);
    assert.equal(passageMessage(longCtl, passage({ eventId: longEvt })).msgId, a.msgId, 'deterministe');
    const b = passageMessage(longCtl, passage({ eventId: 'e'.repeat(39) + 'f' }));
    assert.notEqual(a.msgId, b.msgId);
    const c = passageMessage('C'.repeat(31) + 'D', passage({ eventId: longEvt }));
    assert.notEqual(a.msgId, c.msgId, 'deux controleurs distincts');
    // identifiant d'evenement avec caracteres interdits : message quand meme valide
    const d = passageMessage('CTL-1', passage({ eventId: 'rec 12/34;é' }));
    assert.match(d.msgId!, MSG_ID);
    assert.match(d.access!.eventId, /^[A-Za-z0-9._:-]{1,40}$/);
    assert.equal(d.msgId, `acc:CTL-1:${d.access!.eventId}`);
    // court : pas de transformation
    assert.equal(passageMessage('CTL-1', passage({ eventId: 'a1' })).msgId, 'acc:CTL-1:a1');
    // au plus 64 caracteres pile : inchange
    const edge = 'k'.repeat(40);
    assert.equal(passageMessage('C'.repeat(19), passage({ eventId: edge })).msgId, `acc:${'C'.repeat(19)}:${edge}`, '64 caracteres pile : inchange');
    assert.equal(passageMessage('C'.repeat(20), passage({ eventId: edge })).msgId!.length, 64, '65 caracteres : empreinte, 64 pile');
  });

  it('nom tronque a 64 caracteres, sans couper un emoji', () => {
    const m = passageMessage('CTL-1', passage({ holderName: 'N'.repeat(200) }));
    assert.equal(m.access?.holderName, 'N'.repeat(64));
    const e = passageMessage('CTL-1', passage({ holderName: 'N'.repeat(63) + EMOJI }));
    assert.equal(e.access?.holderName, 'N'.repeat(63));
    const f = passageMessage('CTL-1', passage({ holderName: EMOJI.repeat(50) }));
    assert.equal(f.access?.holderName, EMOJI.repeat(32));
  });

  it('message final de 1 024 octets au plus : le nom est raccourci, jamais un autre champ', () => {
    const worst = passage({
      eventId: 'e'.repeat(40),
      credential: 'c'.repeat(32),
      holderRef: 'r'.repeat(32),
      holderName: '"'.repeat(64),
      result: 'denied',
      reason: 'unknown_credential',
      deferred: true,
    });
    const full = passageMessage('C'.repeat(32), worst);
    assert.ok(Buffer.byteLength(JSON.stringify(full)) <= 1024);
    // limite artificielle : le nom (guillemets echappes, 2 octets chacun) est raccourci
    const bare = Buffer.byteLength(JSON.stringify(passageMessage('C'.repeat(32), { ...worst, holderName: null })));
    const small = passageMessage('C'.repeat(32), worst, bare + 30);
    assert.ok(Buffer.byteLength(JSON.stringify(small)) <= bare + 30);
    assert.ok((small.access!.holderName ?? '').length < 64);
    assert.equal(small.access?.credential, 'c'.repeat(32));
    assert.equal(small.access?.eventId, 'e'.repeat(40));
    // nom en emoji (4 octets chacun) raccourci sans moitie d'emoji
    const emo = passageMessage('CTL-1', passage({ holderName: EMOJI.repeat(32) }), 300);
    assert.ok(Buffer.byteLength(JSON.stringify(emo)) <= 300);
    const name = emo.access?.holderName ?? '';
    assert.equal(name, EMOJI.repeat(name.length / 2));
    // impossible de tenir meme sans nom : exception
    assert.throws(() => passageMessage('CTL-1', passage(), 50), /trop gros/);
    // sans nom, le message nominal est bien en dessous de la limite
    assert.ok(Buffer.byteLength(JSON.stringify(passageMessage('CTL-1', passage({ holderName: null })))) < 400);
  });

  it('donnees hostiles : exceptions claires, sans citer la donnee', () => {
    assert.throws(() => passageMessage('CTL-1', passage({ ts: Number.NaN })), /heure du passage invalide/);
    assert.throws(() => passageMessage('CTL-1', passage({ ts: 1_760_000_000 })), /heure du passage invalide/);
    assert.throws(() => passageMessage('CTL-1', passage({ ts: -5 })), /heure du passage invalide/);
    assert.throws(() => passageMessage('CTL-1', passage({ ts: '1760000000000' as never })), /heure/);
    assert.throws(() => passageMessage('', passage()), /controleur/);
    assert.throws(() => passageMessage('CTL 1', passage()), /controleur/);
    assert.throws(() => passageMessage('C'.repeat(33), passage()), /controleur/);
    assert.throws(() => passageMessage('CTL-1', passage({ eventId: '' })), /evenement/);
    assert.throws(() => passageMessage('CTL-1', passage({ eventId: {} as never })), /evenement/);
    assert.throws(() => passageMessage('CTL-1', passage({ result: 'peut-etre' as never })), /resultat/);
    try {
      passageMessage('CTL-1', passage({ ts: Number.NaN, holderName: 'SECRET NOM', credential: 'BADGE999' }));
    } catch (e) {
      assert.ok(!String((e as Error).message).includes('SECRET'));
      assert.ok(!String((e as Error).message).includes('BADGE999'));
    }
  });

  it('chaines enormes et caracteres de controle : message valide quand meme', () => {
    const m = passageMessage(
      'CTL-1',
      passage({
        holderName: 'A\nB' + cp(0, 0x1b) + 'C'.repeat(1_000_000),
        credential: '1'.repeat(1_000_000),
        holderRef: ('x' + cp(0)).repeat(1_000),
        eventId: '7'.repeat(100_000),
      }),
    );
    assert.ok(Buffer.byteLength(JSON.stringify(m)) <= 1024);
    assert.equal(m.access?.holderName?.startsWith('A B C'), true);
    assert.equal(m.access?.credential?.length, 32);
    assert.match(m.msgId!, MSG_ID);
  });

  it('prepare() du socle accepte les messages de passage', () => {
    for (const p of [passage(), passage({ result: 'denied', reason: 'expired' }), passage({ holderName: null, credential: null, method: 'remote' }), passage({ eventId: 'e'.repeat(40) })]) {
      const msg = passageMessage('C'.repeat(32), p);
      const r = prepare('PORTE-1', msg, T0);
      assert.equal(r.ok, true, JSON.stringify(r));
      if (r.ok) {
        assert.equal(r.payload.msgId, msg.msgId);
        assert.equal(r.payload.ts, msg.ts);
        assert.equal(r.payload.event, msg.event);
        // Tant que validate.ts ne transmet pas `access`, il avertit ; une fois renforce, il le garde tel quel.
        if ('access' in r.payload) assert.deepEqual(r.payload.access, msg.access);
        else assert.ok(r.warnings.some((w) => w.includes('access')), 'le champ access est ignore avec un avertissement');
        assert.ok(r.warnings.every((w) => w.includes('access')), `avertissements inattendus : ${r.warnings.join(' | ')}`);
        assert.ok(r.bytes <= 1024);
      }
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('acces-commun : message d\'etat d\'une porte', () => {
  const spec = { controllerId: 'CTL-1', doorNo: 2, kind: 'forced', psimEvent: 'door_forced', ts: T0 };

  it('format et msgId deterministe', () => {
    const m = doorEventMessage(spec);
    assert.deepEqual(m, { event: 'door_forced', ts: T0, msgId: `acc:CTL-1:forced-2-${T0}` });
    assert.deepEqual(doorEventMessage(spec), m, 'meme evenement = meme message');
    assert.deepEqual(doorEventMessage({ ...spec, idPart: '88' }), { event: 'door_forced', ts: T0, msgId: `acc:CTL-1:forced-2-${T0}-88` });
    assert.deepEqual(doorEventMessage({ ...spec, idPart: '' }), m);
  });

  it('deux evenements distincts = deux msgId distincts', () => {
    const ids = new Set([
      doorEventMessage(spec).msgId,
      doorEventMessage({ ...spec, ts: T0 + 1 }).msgId,
      doorEventMessage({ ...spec, doorNo: 3 }).msgId,
      doorEventMessage({ ...spec, kind: 'opened' }).msgId,
      doorEventMessage({ ...spec, controllerId: 'CTL-2' }).msgId,
      doorEventMessage({ ...spec, idPart: 'a' }).msgId,
      doorEventMessage({ ...spec, idPart: 'b' }).msgId,
    ]);
    assert.equal(ids.size, 7);
  });

  it('identifiants longs ou hostiles : msgId valide, borne a 64, toujours deterministe et distinct', () => {
    const long = doorEventMessage({ ...spec, controllerId: 'C'.repeat(32), kind: 'denied_repeated', idPart: 'x'.repeat(5000) });
    assert.match(long.msgId!, MSG_ID);
    assert.ok(long.msgId!.length <= 64);
    assert.equal(doorEventMessage({ ...spec, controllerId: 'C'.repeat(32), kind: 'denied_repeated', idPart: 'x'.repeat(5000) }).msgId, long.msgId);
    assert.notEqual(doorEventMessage({ ...spec, controllerId: 'C'.repeat(32), kind: 'denied_repeated', idPart: 'x'.repeat(4999) + 'y' }).msgId, long.msgId);
    const hostile = doorEventMessage({ ...spec, idPart: 'a b/c;d' + cp(0xe9, 0) });
    assert.match(hostile.msgId!, MSG_ID);
    assert.notEqual(hostile.msgId, doorEventMessage({ ...spec, idPart: 'a b/c;d' + cp(0xe8, 0) }).msgId);
  });

  it('ts ou controleur invalide : exception', () => {
    assert.throws(() => doorEventMessage({ ...spec, ts: 12 }), /heure/);
    assert.throws(() => doorEventMessage({ ...spec, ts: Number.NaN }), /heure/);
    assert.throws(() => doorEventMessage({ ...spec, controllerId: 'a b' }), /controleur/);
  });

  it('prepare() du socle accepte les messages d\'etat', () => {
    for (const [kind, psimEvent] of [['opened', 'door_opened'], ['closed', 'door_closed'], ['forced', 'door_forced'], ['held', 'door_held_open'], ['t', 'tamper'], ['r', 'restored'], ['d', 'clock_drift'], ['x', 'badge_denied_repeated']] as const) {
      const r = prepare('PORTE-1', doorEventMessage({ ...spec, kind, psimEvent }), T0);
      assert.equal(r.ok, true);
      if (r.ok) assert.deepEqual(r.warnings, [], `${psimEvent} est connu du PSIM`);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('acces-commun : compteur de refus', () => {
  it('3 refus en 60 s declenchent, 2 non', () => {
    const c = new DenialCounter();
    assert.equal(c.record(1, T0), false);
    assert.equal(c.record(1, T0 + 10 * SEC), false);
    assert.equal(c.record(1, T0 + 20 * SEC), true);
    const d = new DenialCounter();
    assert.equal(d.record(1, T0), false);
    assert.equal(d.record(1, T0 + 10 * SEC), false);
    assert.equal(d.pending(1), 2);
  });

  it('bornes de la fenetre incluses : 0, 30 et 60 s declenchent ; 0, 30 et 60,001 s non', () => {
    const a = new DenialCounter();
    a.record(1, T0);
    a.record(1, T0 + 30 * SEC);
    assert.equal(a.record(1, T0 + 60 * SEC), true);
    const b = new DenialCounter();
    b.record(1, T0);
    b.record(1, T0 + 30 * SEC);
    assert.equal(b.record(1, T0 + 60 * SEC + 1), false);
  });

  it('la fenetre glisse', () => {
    const c = new DenialCounter();
    assert.equal(c.record(1, T0), false);
    assert.equal(c.record(1, T0 + 50 * SEC), false);
    assert.equal(c.record(1, T0 + 100 * SEC), false, '0, 50, 100 : jamais 3 dans 60 s');
    assert.equal(c.record(1, T0 + 110 * SEC), true, '50, 100, 110 : oui');
  });

  it('remise a zero apres declenchement : il faut X nouveaux refus', () => {
    const c = new DenialCounter();
    c.record(1, T0);
    c.record(1, T0 + SEC);
    assert.equal(c.record(1, T0 + 2 * SEC), true);
    assert.equal(c.pending(1), 0);
    assert.equal(c.record(1, T0 + 3 * SEC), false);
    assert.equal(c.record(1, T0 + 4 * SEC), false);
    assert.equal(c.record(1, T0 + 5 * SEC), true);
  });

  it('evenements recus dans le desordre', () => {
    const c = new DenialCounter();
    assert.equal(c.record(1, T0 + 20 * SEC), false);
    assert.equal(c.record(1, T0), false);
    assert.equal(c.record(1, T0 + 10 * SEC), true, 'recu en dernier mais au milieu');
    // anciens refus recus apres un refus tres recent
    const d = new DenialCounter();
    assert.equal(d.record(1, T0 + 1000 * SEC), false);
    assert.equal(d.record(1, T0 + 10 * SEC), false);
    assert.equal(d.record(1, T0 + 20 * SEC), false);
    assert.equal(d.record(1, T0 + 30 * SEC), true, 'un salve ancienne recuperee en differe');
  });

  it('refus a la meme milliseconde comptes separement', () => {
    const c = new DenialCounter();
    assert.equal(c.record(1, T0), false);
    assert.equal(c.record(1, T0), false);
    assert.equal(c.record(1, T0), true);
  });

  it('portes independantes', () => {
    const c = new DenialCounter();
    c.record(1, T0);
    c.record(2, T0 + SEC);
    c.record(1, T0 + 2 * SEC);
    assert.equal(c.record(2, T0 + 3 * SEC), false);
    assert.equal(c.record(1, T0 + 4 * SEC), true);
    assert.equal(c.pending(2), 2, 'la porte 2 n\'est pas remise a zero par la porte 1');
    assert.equal(c.record(2, T0 + 5 * SEC), true);
  });

  it('seuil et fenetre reglables ; seuil 1 declenche a chaque refus', () => {
    const c = new DenialCounter({ count: 5, windowS: 10 });
    for (let i = 0; i < 4; i++) assert.equal(c.record(1, T0 + i * 2 * SEC), false);
    assert.equal(c.record(1, T0 + 8 * SEC), true);
    const one = new DenialCounter({ count: 1 });
    assert.equal(one.record(1, T0), true);
    assert.equal(one.record(1, T0 + 1), true);
    assert.equal(new DenialCounter().count, 3);
    assert.equal(new DenialCounter().windowMs, 60_000);
  });

  it('parametres invalides : exception', () => {
    for (const count of [0, -1, 1.5, Number.NaN]) assert.throws(() => new DenialCounter({ count }), RangeError);
    for (const windowS of [0, -5, Number.NaN, Infinity]) assert.throws(() => new DenialCounter({ windowS }), RangeError);
  });

  it('heures inutilisables ignorees', () => {
    const c = new DenialCounter();
    for (const ts of [Number.NaN, 0, -1, 1.5, Infinity, 2 ** 60]) assert.equal(c.record(1, ts), false, String(ts));
    assert.equal(c.pending(1), 0);
    assert.equal(c.tracked, 0);
  });

  it('memoire bornee : portes et refus par porte', () => {
    const c = new DenialCounter({ maxDoors: 4 });
    for (let door = 0; door < 1000; door++) c.record(door, T0);
    assert.equal(c.tracked, 4);
    const d = new DenialCounter({ count: 3, windowS: 1 });
    // refus espaces de plus d'une fenetre : jamais de declenchement, mais la liste ne grossit pas
    for (let i = 0; i < 10_000; i++) assert.equal(d.record(1, T0 + i * 5 * SEC), false);
    assert.ok(d.pending(1) <= 16, `${d.pending(1)} refus gardes`);
    // un tres vieux refus recu apres 16 plus recents est simplement oublie
    assert.equal(d.record(1, T0 - 10 * SEC), false);
    assert.ok(d.pending(1) <= 16);
  });

  it('reset', () => {
    const c = new DenialCounter();
    c.record(1, T0);
    c.record(2, T0);
    c.reset(1);
    assert.equal(c.pending(1), 0);
    assert.equal(c.pending(2), 1);
    c.reset();
    assert.equal(c.tracked, 0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('acces-commun : journal limite', () => {
  it('un meme message au plus une fois par minute, puis le nombre de masques', () => {
    const lines: string[] = [];
    const clock = { t: T0 };
    const log = createLimitedLog((_l, text) => lines.push(text), () => clock.t);
    for (let i = 0; i < 50; i++) log('k', 'warn', 'meme probleme');
    assert.deepEqual(lines, ['meme probleme']);
    clock.t += 59 * SEC;
    log('k', 'warn', 'meme probleme');
    assert.equal(lines.length, 1);
    clock.t += 2 * SEC;
    log('k', 'warn', 'meme probleme');
    assert.equal(lines.length, 2);
    assert.match(lines[1]!, /\(50 message\(s\) semblable\(s\) non affiche\(s\)\)/);
    log('autre', 'info', 'autre probleme');
    assert.equal(lines.length, 3);
  });

  it('plafond global par minute, annonce a la minute suivante', () => {
    const lines: string[] = [];
    const clock = { t: T0 };
    const log = createLimitedLog((_l, text) => lines.push(text), () => clock.t);
    for (let i = 0; i < 100; i++) log(`cle-${i}`, 'warn', `message ${i}`);
    assert.equal(lines.length, 30);
    clock.t += 61 * SEC;
    log('neuf', 'warn', 'apres');
    assert.equal(lines.length, 32);
    assert.match(lines[30]!, /70 message\(s\)/);
    assert.equal(lines[31], 'apres');
  });

  it('texte nettoye : pas de retour a la ligne, borne', () => {
    const lines: string[] = [];
    const log = createLimitedLog((_l, text) => lines.push(text), () => T0);
    log('a', 'warn', 'ligne1\nligne2\r\nFAUX journal ' + 'x'.repeat(1000));
    assert.equal(lines.length, 1);
    assert.ok(!/[\r\n]/.test(lines[0]!));
    assert.ok(lines[0]!.length <= 300);
  });

  it('horloge revenue en arriere : pas de blocage', () => {
    const lines: string[] = [];
    const clock = { t: T0 };
    const log = createLimitedLog((_l, text) => lines.push(text), () => clock.t);
    log('k', 'warn', 'a');
    clock.t -= 3600 * SEC;
    log('k', 'warn', 'a');
    assert.equal(lines.length, 2);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('acces-commun : curseurs de recuperation (F8)', () => {
  function store(dir: string, clock: { t: number }, extra: { io?: Partial<CursorIo>; compare?: (a: string, b: string) => number } = {}) {
    const logs: string[] = [];
    const s = new CursorStore({ dir, now: () => clock.t, log: (_l, text) => logs.push(text), ...extra });
    return { s, logs };
  }

  it('memorise et relit apres arret / redemarrage', () => {
    const dir = tmp();
    const clock = { t: T0 };
    const a = store(dir, clock);
    assert.equal(a.s.get('CTL-1'), null);
    assert.equal(a.s.set('CTL-1', '1500', T0 + 5), true);
    assert.deepEqual(a.s.get('CTL-1'), { cursor: '1500', ts: T0 + 5 });
    a.s.flush();
    assert.ok(existsSync(join(dir, CURSOR_FILE)));
    assert.equal(CURSOR_FILE, 'acces-curseurs.json');
    const b = store(dir, clock);
    assert.deepEqual(b.s.get('CTL-1'), { cursor: '1500', ts: T0 + 5 });
    assert.deepEqual(b.logs, []);
    assert.equal(b.s.get('CTL-2'), null);
  });

  it('cree le dossier au besoin', () => {
    const dir = join(tmp(), 'a', 'b', 'c');
    const { s } = store(dir, { t: T0 });
    s.set('CTL-1', '1', T0);
    s.flush();
    assert.ok(existsSync(join(dir, CURSOR_FILE)));
  });

  it('get rend une copie : la modifier ne change rien', () => {
    const { s } = store(tmp(), { t: T0 });
    s.set('CTL-1', '10', T0);
    const e = s.get('CTL-1')!;
    e.cursor = 'zzz';
    assert.equal(s.get('CTL-1')?.cursor, '10');
  });

  it('ne recule jamais (comparaison numerique par defaut, entiers longs sans perte)', () => {
    const { s } = store(tmp(), { t: T0 });
    assert.equal(s.set('CTL-1', '100', T0), true);
    assert.equal(s.set('CTL-1', '99', T0 + 1), false);
    assert.equal(s.set('CTL-1', '9', T0 + 1), false, 'numerique, pas alphabetique');
    assert.equal(s.get('CTL-1')?.cursor, '100');
    assert.equal(s.set('CTL-1', '100', T0), false, 'egal : sans effet');
    assert.equal(s.set('CTL-1', '101', T0 + 2), true);
    assert.equal(s.set('CTL-1', '12345678901234567890', T0 + 3), true);
    assert.equal(s.set('CTL-1', '12345678901234567889', T0 + 4), false, 'au dela de 2^53');
    assert.equal(s.set('CTL-1', '12345678901234567891', T0 + 5), true);
    assert.equal(s.set('CTL-1', '1.5', T0 + 6), false);
  });

  it('curseurs non numeriques : ordre d\'arrivee ; comparateur fourni respecte', () => {
    const { s } = store(tmp(), { t: T0 });
    assert.equal(s.set('CTL-1', '2026-10-17T10:00:00Z', T0), true);
    assert.equal(s.set('CTL-1', '2026-10-17T09:00:00Z', T0 + 1), true, 'sans comparateur, le dernier arrive gagne');
    assert.equal(s.get('CTL-1')?.cursor, '2026-10-17T09:00:00Z');
    const { s: t } = store(tmp(), { t: T0 }, { compare: (a, b) => a.localeCompare(b) });
    assert.equal(t.set('CTL-1', 'b', T0), true);
    assert.equal(t.set('CTL-1', 'a', T0), false);
    assert.equal(t.set('CTL-1', 'c', T0), true);
    // comparateur defaillant : ordre d'arrivee et avertissement, pas d'exception
    const { s: u, logs } = store(tmp(), { t: T0 }, {
      compare: () => {
        throw new Error('boom');
      },
    });
    assert.equal(u.set('CTL-1', '1', T0), true);
    assert.equal(u.set('CTL-1', '2', T0), true);
    assert.equal(logs.length, 1);
    assert.deepEqual([defaultCursorCompare('9', '10'), defaultCursorCompare('b', '10'), defaultCursorCompare('3', '3')], [-1, 1, 0]);
  });

  it('valeurs invalides refusees : controleur, curseur (vide, trop long, caracteres de controle), heure', () => {
    const { s, logs } = store(tmp(), { t: T0 });
    assert.equal(s.set('CTL 1', '1', T0), false);
    assert.equal(s.set('', '1', T0), false);
    assert.equal(s.set('CTL-1', '', T0), false);
    assert.equal(s.set('CTL-1', 'x'.repeat(129), T0), false);
    assert.equal(s.set('CTL-1', 'a\nb', T0), false);
    assert.equal(s.set('CTL-1', 'a' + cp(0), T0), false);
    assert.equal(s.set('CTL-1', 12 as never, T0), false);
    assert.equal(s.set('CTL-1', {} as never, T0), false);
    assert.equal(s.set('CTL-1', '1', -1), false);
    assert.equal(s.set('CTL-1', '1', Number.NaN), false);
    assert.equal(s.set('CTL-1', '1', 1.5), false);
    assert.equal(s.get('CTL-1'), null);
    assert.equal(s.set('CTL-1', 'x'.repeat(128), T0), true);
    assert.ok(logs.length >= 1 && logs.length <= 10);
  });

  it('ecriture groupee : une premiere ecriture tout de suite, puis au plus une par seconde', () => {
    const writes: string[] = [];
    const clock = { t: T0 };
    const dir = tmp();
    const { s } = store(dir, clock, {
      io: {
        write: (file, data) => {
          writes.push(data);
          writeFileSync(file, data);
        },
      },
    });
    s.set('CTL-1', '1', T0);
    s.tick();
    assert.equal(writes.length, 1, 'premiere ecriture immediate');
    s.set('CTL-1', '2', T0 + 1);
    s.tick();
    clock.t += 500;
    s.set('CTL-1', '3', T0 + 2);
    s.tick();
    assert.equal(writes.length, 1, 'moins d\'une seconde : rien');
    clock.t += 499;
    s.tick();
    assert.equal(writes.length, 1);
    clock.t += 1;
    s.tick();
    assert.equal(writes.length, 2, 'une seconde apres : une seule ecriture pour les deux changements');
    assert.equal((JSON.parse(writes[1]!) as { controllers: Record<string, { cursor: string }> }).controllers['CTL-1']?.cursor, '3');
    clock.t += 10 * SEC;
    s.tick();
    s.tick();
    assert.equal(writes.length, 2, 'rien a ecrire : pas d\'ecriture');
    assert.equal(JSON.parse(readFileSync(join(dir, CURSOR_FILE), 'utf8')).controllers['CTL-1'].cursor, '3');
  });

  it('flush ecrit tout de suite, de facon synchrone, et sans rien a ecrire ne fait rien', () => {
    const writes: number[] = [];
    const dir = tmp();
    const { s } = store(dir, { t: T0 }, { io: { write: (file, data) => (writes.push(1), writeFileSync(file, data)) } });
    s.flush();
    assert.equal(writes.length, 0);
    s.set('CTL-1', '5', T0);
    s.set('CTL-1', '6', T0);
    s.flush();
    assert.equal(writes.length, 1);
    s.flush();
    assert.equal(writes.length, 1);
    assert.equal(JSON.parse(readFileSync(join(dir, CURSOR_FILE), 'utf8')).controllers['CTL-1'].cursor, '6');
  });

  it('horloge revenue en arriere : on ecrit quand meme', () => {
    const writes: number[] = [];
    const clock = { t: T0 };
    const { s } = store(tmp(), clock, { io: { write: (file, data) => (writes.push(1), writeFileSync(file, data)) } });
    s.set('CTL-1', '1', T0);
    s.tick();
    clock.t -= 3600 * SEC;
    s.set('CTL-1', '2', T0);
    s.tick();
    assert.equal(writes.length, 2);
  });

  it('ecriture atomique : fichier temporaire puis renommage ; aucun reste apres succes', () => {
    const dir = tmp();
    const { s } = store(dir, { t: T0 });
    s.set('CTL-1', '1', T0);
    s.flush();
    assert.deepEqual(readdirSync(dir), [CURSOR_FILE]);
  });

  it('coupure entre l\'ecriture et le renommage : l\'ancien fichier reste intact, nouvel essai plus tard', () => {
    const dir = tmp();
    const clock = { t: T0 };
    let failRename = false;
    const { s, logs } = store(dir, clock, {
      io: {
        rename: (from, to) => {
          if (failRename) throw new Error('disque en panne');
          renameSyncReal(from, to);
        },
      },
    });
    s.set('CTL-1', '1', T0);
    s.flush();
    const before = readFileSync(join(dir, CURSOR_FILE), 'utf8');
    failRename = true;
    s.set('CTL-1', '2', T0 + 1);
    assert.doesNotThrow(() => s.flush());
    assert.equal(readFileSync(join(dir, CURSOR_FILE), 'utf8'), before, 'ancien fichier intact');
    assert.ok(logs.some((l) => l.includes('ecriture des curseurs')));
    // un redemarrage a ce moment relit l'ancien etat complet
    const r = store(dir, clock);
    assert.equal(r.s.get('CTL-1')?.cursor, '1');
    assert.deepEqual(r.logs, []);
    // le disque revient : le prochain tick ecrit (l'etat est reste « a ecrire »)
    failRename = false;
    clock.t += 2 * SEC;
    s.tick();
    assert.equal(JSON.parse(readFileSync(join(dir, CURSOR_FILE), 'utf8')).controllers['CTL-1'].cursor, '2');
  });

  it('fichier absent, vide, tronque, corrompu, mauvais format, trop gros : etat vide, avertissement, jamais d\'exception', () => {
    const cases: Array<[string, string]> = [
      ['vide', ''],
      ['espaces', '   \n '],
      ['tronque', '{"v":1,"controllers":{"CTL-1":{"cursor":"12'],
      ['illisible', cp(0x00, 0x01, 0x02) + 'garbage'],
      ['tableau', '[1,2,3]'],
      ['nul', 'null'],
      ['nombre', '42'],
      ['sans controllers', '{"v":1}'],
      ['controllers tableau', '{"controllers":[]}'],
      ['controllers texte', '{"controllers":"x"}'],
      ['trop gros', '{"controllers":{},"x":"' + 'a'.repeat(1_100_000) + '"}'],
    ];
    for (const [name, content] of cases) {
      const dir = tmp();
      writeFileSync(join(dir, CURSOR_FILE), content);
      const { s, logs } = store(dir, { t: T0 });
      assert.equal(s.get('CTL-1'), null, name);
      assert.equal(logs.length, 1, `${name} : un avertissement`);
      // et le magasin reste utilisable
      assert.equal(s.set('CTL-1', '7', T0), true, name);
      s.flush();
      assert.equal(JSON.parse(readFileSync(join(dir, CURSOR_FILE), 'utf8')).controllers['CTL-1'].cursor, '7', name);
    }
    // absent : etat vide, silencieux
    const { s, logs } = store(tmp(), { t: T0 });
    assert.equal(s.get('CTL-1'), null);
    assert.deepEqual(logs, []);
  });

  it('fichier hostile : seules les entrees valides sont gardees ; BOM tolere', () => {
    const dir = tmp();
    const body = JSON.stringify({
      controllers: {
        'CTL-1': { cursor: '42', ts: T0 },
        'CTL 2': { cursor: '1', ts: T0 },
        'CTL-3': { cursor: '', ts: T0 },
        'CTL-4': { cursor: 'a\nb', ts: T0 },
        'CTL-5': { cursor: '1', ts: -4 },
        'CTL-6': { cursor: 7, ts: T0 },
        'CTL-7': null,
        'CTL-8': 'texte',
        'CTL-9': { cursor: 'x'.repeat(500), ts: T0 },
      },
    });
    writeFileSync(join(dir, CURSOR_FILE), String.fromCharCode(0xfeff) + body);
    const { s, logs } = store(dir, { t: T0 });
    assert.deepEqual(s.get('CTL-1'), { cursor: '42', ts: T0 });
    for (const id of ['CTL 2', 'CTL-3', 'CTL-4', 'CTL-5', 'CTL-6', 'CTL-7', 'CTL-8', 'CTL-9']) assert.equal(s.get(id), null, id);
    assert.equal(logs.length, 1);
    assert.match(logs[0]!, /7 entree\(s\)|8 entree\(s\)/);
  });

  it('cle __proto__ dans le fichier : aucune pollution', () => {
    const dir = tmp();
    writeFileSync(join(dir, CURSOR_FILE), '{"controllers":{"__proto__":{"cursor":"5","ts":1760000000000},"constructor":{"cursor":"6","ts":1760000000000}}}');
    const { s } = store(dir, { t: T0 });
    assert.equal(({} as Record<string, unknown>).cursor, undefined);
    assert.equal(s.get('__proto__')?.cursor, '5');
    s.set('__proto__', '9', T0);
    s.flush();
    assert.equal(({} as Record<string, unknown>).cursor, undefined);
    const again = store(dir, { t: T0 });
    assert.equal(again.s.get('__proto__')?.cursor, '9');
    assert.equal(again.s.get('constructor')?.cursor, '6');
  });

  it('deux magasins dans le meme dossier (dahua et zkteco) ne s\'ecrasent pas', () => {
    const dir = tmp();
    const clock = { t: T0 };
    const a = store(dir, clock).s;
    const b = store(dir, clock).s;
    a.set('DAHUA-1', '10', T0);
    a.flush();
    b.set('ZK-1', '20', T0);
    b.flush();
    a.set('DAHUA-1', '11', T0 + 1);
    a.flush();
    const c = store(dir, clock).s;
    assert.equal(c.get('DAHUA-1')?.cursor, '11');
    assert.equal(c.get('ZK-1')?.cursor, '20');
  });

  it('fichier corrompu au moment de l\'ecriture : les entrees en memoire sont reecrites', () => {
    const dir = tmp();
    const { s } = store(dir, { t: T0 });
    s.set('CTL-1', '1', T0);
    s.flush();
    writeFileSync(join(dir, CURSOR_FILE), '{{{{');
    s.set('CTL-2', '2', T0);
    s.flush();
    const r = store(dir, { t: T0 }).s;
    assert.equal(r.get('CTL-1')?.cursor, '1');
    assert.equal(r.get('CTL-2')?.cursor, '2');
  });

  it('dossier inutilisable (un fichier a sa place) : pas d\'exception, avertissements', () => {
    const base = tmp();
    const blocker = join(base, 'bloque');
    writeFileSync(blocker, 'je suis un fichier');
    const { s, logs } = store(join(blocker, 'sous'), { t: T0 });
    assert.ok(logs.length >= 1);
    assert.equal(s.set('CTL-1', '1', T0), true);
    assert.doesNotThrow(() => s.flush());
    assert.doesNotThrow(() => s.tick());
    assert.equal(s.get('CTL-1')?.cursor, '1', 'garde en memoire');
  });

  it('nombre de controleurs borne', () => {
    const { s } = store(tmp(), { t: T0 });
    let accepted = 0;
    for (let i = 0; i < 400; i++) if (s.set(`C${i}`, '1', T0)) accepted++;
    assert.equal(accepted, 256);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
type Sent = { id: string; msg: DeviceMessage };

interface Rig {
  sup: ControllerSupervisor;
  clock: { t: number };
  sent: Sent[];
  logs: Array<{ level: string; text: string }>;
  dir: string;
  cursors: CursorStore;
  /** Mettre a false pour que le socle refuse tout (disque plein). */
  accept: { value: boolean; only?: (id: string, msg: DeviceMessage) => boolean };
  /** Evenements (ou etats) envoyes, dans l'ordre, par identifiant de detecteur. */
  names(id?: string): string[];
  advance(ms: number, step?: number, keepAlive?: boolean): void;
}

function rig(opts: { thresholds?: PartialThresholds; doors?: Map<number, string>; onOffline?: never; dir?: string; controllerId?: string } = {}): Rig {
  const clock = { t: T0 };
  const sent: Sent[] = [];
  const logs: Array<{ level: string; text: string }> = [];
  const accept: Rig['accept'] = { value: true };
  const log = (level: string, text: string): void => void logs.push({ level, text });
  const dir = opts.dir ?? tmp();
  const cursors = new CursorStore({ dir, now: () => clock.t, log });
  const sup = new ControllerSupervisor({
    controllerId: opts.controllerId ?? 'CTL-1',
    doors: opts.doors ?? new Map([[1, 'PORTE-1'], [2, 'PORTE-2']]),
    emit: (id, msg) => {
      if (!accept.value) return false;
      if (accept.only && !accept.only(id, msg)) return false;
      sent.push({ id, msg });
      return true;
    },
    now: () => clock.t,
    log,
    cursors,
    thresholds: opts.thresholds,
  });
  const names = (id?: string): string[] => sent.filter((s) => id === undefined || s.id === id).map((s) => s.msg.event ?? s.msg.state ?? '?');
  const advance = (ms: number, step = SEC, keepAlive = false): void => {
    const end = clock.t + ms;
    while (clock.t < end) {
      clock.t = Math.min(end, clock.t + step);
      if (keepAlive) sup.alive();
      sup.tick();
    }
  };
  return { sup, clock, sent, logs, dir, cursors, accept, names, advance };
}

describe('acces-commun : superviseur - construction', () => {
  const base = { doors: new Map([[1, 'P-1']]), emit: () => true, now: () => T0, log: () => undefined, cursors: new CursorStore({ dir: tmp(), now: () => T0, log: () => undefined }) };

  it('identifiants invalides : RangeError des la construction', () => {
    for (const controllerId of ['', 'a b', 'C'.repeat(33), 'é', '../x', 12 as never]) {
      assert.throws(() => new ControllerSupervisor({ ...base, controllerId }), RangeError, String(controllerId));
    }
    assert.throws(() => new ControllerSupervisor({ ...base, controllerId: 'CTL-1', doors: new Map() }), /au moins une porte/);
    assert.throws(() => new ControllerSupervisor({ ...base, controllerId: 'CTL-1', doors: new Map([[1, 'a b']]) }), /detecteur invalide/);
    assert.throws(() => new ControllerSupervisor({ ...base, controllerId: 'CTL-1', doors: new Map([[-1, 'P']]) }), /numero de porte/);
    assert.throws(() => new ControllerSupervisor({ ...base, controllerId: 'CTL-1', doors: new Map([[1.5, 'P']]) }), /numero de porte/);
  });

  it('seuils : valeurs par defaut, valeurs invalides ignorees, copie des portes', () => {
    const doors = new Map([[1, 'P-1']]);
    const s = new ControllerSupervisor({ ...base, controllerId: 'CTL-1', doors });
    assert.deepEqual(s.thresholds, { denied: { count: 3, windowS: 60 }, heartbeatS: 60, driftMs: 120_000, driftRecheckS: 300, silenceMs: 30_000, offlineGraceMs: 15_000 });
    const bad = new ControllerSupervisor({
      ...base,
      controllerId: 'CTL-1',
      thresholds: { denied: { count: 0, windowS: -1 }, heartbeatS: Number.NaN, driftMs: 'x' as never, driftRecheckS: -1, silenceMs: 0, offlineGraceMs: -5 },
    });
    assert.deepEqual(bad.thresholds, s.thresholds);
    const custom = new ControllerSupervisor({ ...base, controllerId: 'CTL-1', thresholds: { denied: { count: 5 }, heartbeatS: 10, offlineGraceMs: 0 } });
    assert.equal(custom.thresholds.denied.count, 5);
    assert.equal(custom.thresholds.denied.windowS, 60);
    assert.equal(custom.thresholds.heartbeatS, 10);
    assert.equal(custom.thresholds.offlineGraceMs, 0);
    doors.set(9, 'AUTRE');
    assert.equal(s.state().doors.length, 1, 'la table des portes est copiee');
  });

  it('etat initial', () => {
    const r = rig();
    const st = r.sup.state();
    assert.equal(st.link, 'unknown');
    assert.equal(st.online, false);
    assert.equal(st.lastAliveAt, null);
    assert.equal(st.doors.length, 2);
    assert.deepEqual(st.doors[0], { doorNo: 1, detectorId: 'PORTE-1', open: null, forced: false, held: false, tamper: false, drift: false });
    assert.equal(r.sent.length, 0, 'rien n\'est emis avant la premiere preuve de vie');
  });
});

describe('acces-commun : superviseur - passages', () => {
  it('un passage accepte part vers le detecteur de sa porte', () => {
    const r = rig();
    assert.equal(r.sup.passage(passage({ doorNo: 2 })), true);
    assert.equal(r.sent.length, 1);
    assert.equal(r.sent[0]!.id, 'PORTE-2');
    assert.deepEqual(r.sent[0]!.msg, passageMessage('CTL-1', passage({ doorNo: 2 })));
    assert.equal(r.sup.state().emitted, 1);
  });

  it('une porte inconnue est ignoree (resultat ignored), journal limite', () => {
    const r = rig();
    for (let i = 0; i < 100; i++) assert.equal(r.sup.submit(passage({ doorNo: 9, eventId: `e${i}` })), 'ignored');
    assert.equal(r.sup.passage(passage({ doorNo: 9 })), false);
    assert.equal(r.sent.length, 0);
    assert.equal(r.logs.filter((l) => l.text.includes('porte inconnue')).length, 1);
    assert.equal(r.sup.state().ignored, 101);
    assert.equal(r.sup.submit(passage({ doorNo: Number.NaN })), 'ignored');
    assert.equal(r.sup.submit(passage({ doorNo: '1' as never })), 'ignored');
    assert.equal(r.sup.submit(null as never), 'ignored');
  });

  it('donnees inutilisables ignorees : eventId vide, heure invalide, resultat inconnu', () => {
    const r = rig();
    assert.equal(r.sup.submit(passage({ eventId: '' })), 'ignored');
    assert.equal(r.sup.submit(passage({ eventId: {} as never })), 'ignored');
    assert.equal(r.sup.submit(passage({ ts: Number.NaN })), 'ignored');
    assert.equal(r.sup.submit(passage({ ts: 1_760_000_000 })), 'ignored');
    assert.equal(r.sup.submit(passage({ result: 'x' as never })), 'ignored');
    assert.equal(r.sent.length, 0);
    assert.equal(r.cursors.get('CTL-1'), null);
  });

  it('doublon : un seul message pour deux fois le meme eventId', () => {
    const r = rig();
    assert.equal(r.sup.submit(passage()), 'sent');
    assert.equal(r.sup.submit(passage({ holderName: 'AUTRE NOM' })), 'duplicate');
    assert.equal(r.sup.passage(passage()), true, 'doublon = deja en file');
    assert.equal(r.sent.length, 1);
    assert.equal(r.sup.state().duplicates, 2);
    // un eventId different, meme porte et meme heure : emis
    assert.equal(r.sup.submit(passage({ eventId: '123457' })), 'sent');
    // le meme eventId sur l'AUTRE porte est un doublon aussi (unique par controleur)
    assert.equal(r.sup.submit(passage({ eventId: '123457', doorNo: 2 })), 'duplicate');
    assert.equal(r.sent.length, 2);
  });

  it('doublon detecte meme si l\'identifiant a ete nettoye', () => {
    const r = rig();
    const long = 'x'.repeat(100);
    assert.equal(r.sup.submit(passage({ eventId: long })), 'sent');
    assert.equal(r.sup.submit(passage({ eventId: long })), 'duplicate');
    assert.equal(r.sup.submit(passage({ eventId: 'x'.repeat(99) + 'y' })), 'sent');
    assert.equal(r.sent.length, 2);
    assert.match(r.sent[0]!.msg.msgId!, MSG_ID);
  });

  it('message refuse par le socle (emit renvoie false) : pas emis, pas memorise, pas de curseur, retente = emis', () => {
    const r = rig();
    r.accept.value = false;
    assert.equal(r.sup.submit(passage({ cursor: '500' })), 'refused');
    assert.equal(r.sup.passage(passage({ cursor: '500' })), false);
    assert.equal(r.sent.length, 0);
    assert.equal(r.cursors.get('CTL-1'), null, 'le curseur n\'avance pas');
    assert.equal(r.sup.state().refused, 2);
    r.accept.value = true;
    assert.equal(r.sup.submit(passage({ cursor: '500' })), 'sent');
    assert.equal(r.sent.length, 1);
    assert.deepEqual(r.cursors.get('CTL-1'), { cursor: '500', ts: T0 });
    assert.equal(r.sup.submit(passage({ cursor: '500' })), 'duplicate');
  });

  it('un emit qui renvoie void compte comme emis ; un emit qui leve ne fait pas sortir d\'exception', () => {
    const sent: Sent[] = [];
    const log = () => undefined;
    const cursors = new CursorStore({ dir: tmp(), now: () => T0, log });
    const mk = (emit: (id: string, m: DeviceMessage) => boolean | void) =>
      new ControllerSupervisor({ controllerId: 'CTL-1', doors: new Map([[1, 'P-1']]), emit, now: () => T0, log, cursors });
    const a = mk((id, msg) => void sent.push({ id, msg }));
    assert.equal(a.submit(passage()), 'sent');
    assert.equal(sent.length, 1);
    const b = mk(() => {
      throw new Error('socle en panne');
    });
    assert.equal(b.submit(passage()), 'refused');
    assert.equal(b.state().refused, 1);
    assert.doesNotThrow(() => b.alive());
    assert.doesNotThrow(() => b.tick());
    assert.doesNotThrow(() => b.doorEvent(1, 'forced', T0));
  });

  it('curseur : avance avec les passages emis, ne recule pas, avance aussi sur un doublon plus recent', () => {
    const r = rig();
    r.sup.submit(passage({ eventId: 'a', cursor: '10', ts: T0 }));
    r.sup.submit(passage({ eventId: 'b', cursor: '12', ts: T0 + 5 }));
    assert.deepEqual(r.cursors.get('CTL-1'), { cursor: '12', ts: T0 + 5 });
    // recuperation d'un evenement plus ancien : le curseur ne recule pas
    r.sup.submit(passage({ eventId: 'c', cursor: '11', ts: T0 + 2, deferred: true }));
    assert.equal(r.cursors.get('CTL-1')?.cursor, '12');
    // passage sans curseur : curseur inchange
    r.sup.submit(passage({ eventId: 'd', ts: T0 + 9 }));
    assert.equal(r.cursors.get('CTL-1')?.cursor, '12');
    // doublon de 'a' recu avec un curseur plus grand (vu d'abord en direct sans curseur)
    r.sup.submit(passage({ eventId: 'a', cursor: '13', ts: T0 + 6 }));
    assert.equal(r.cursors.get('CTL-1')?.cursor, '13');
    r.sup.tick();
    const reread = new CursorStore({ dir: r.dir, now: () => T0, log: () => undefined });
    assert.equal(reread.get('CTL-1')?.cursor, '13', 'ecrit par tick()');
  });

  it('flush() du superviseur ecrit les curseurs; survit a un redemarrage', () => {
    const r = rig();
    r.sup.submit(passage({ cursor: '77', ts: T0 + 3 }));
    r.sup.flush();
    const r2 = rig({ dir: r.dir });
    assert.deepEqual(r2.cursors.get('CTL-1'), { cursor: '77', ts: T0 + 3 });
  });

  it('memoire des identifiants bornee (anneau de 4 096)', () => {
    const r = rig();
    for (let i = 0; i < 4096; i++) assert.equal(r.sup.submit(passage({ eventId: `id${i}`, ts: T0 + i })), 'sent');
    assert.equal(r.sup.submit(passage({ eventId: 'id0' })), 'duplicate', 'encore dans l\'anneau');
    for (let i = 4096; i < 4100; i++) r.sup.submit(passage({ eventId: `id${i}`, ts: T0 + i }));
    assert.equal(r.sup.submit(passage({ eventId: 'id0' })), 'sent', 'sorti de l\'anneau');
    assert.equal(r.sup.submit(passage({ eventId: 'id4099' })), 'duplicate');
  });

  it('refus : jamais une alarme a lui seul, seulement badge_denied', () => {
    const r = rig();
    r.sup.submit(passage({ eventId: 'r1', result: 'denied', reason: 'unknown_credential' }));
    r.sup.submit(passage({ eventId: 'r2', result: 'denied', reason: 'expired', ts: T0 + 90 * SEC }));
    assert.deepEqual(r.names(), ['badge_denied', 'badge_denied']);
    assert.equal(r.sent.every((s) => s.msg.state === undefined), true);
  });

  it('3 refus en 60 s : badge_denied_repeated, a l\'heure du refus declencheur, msgId deterministe', () => {
    const r = rig();
    for (let i = 0; i < 3; i++) r.sup.submit(passage({ eventId: `r${i}`, result: 'denied', reason: 'wrong_pin', ts: T0 + i * 10 * SEC }));
    assert.deepEqual(r.names(), ['badge_denied', 'badge_denied', 'badge_denied', 'badge_denied_repeated']);
    const rep = r.sent[3]!;
    assert.equal(rep.id, 'PORTE-1');
    assert.deepEqual(rep.msg, { event: 'badge_denied_repeated', ts: T0 + 20 * SEC, msgId: `acc:CTL-1:denied_repeated-1-${T0 + 20 * SEC}` });
    // remise a zero : deux autres refus ne declenchent pas, le troisieme oui
    r.sup.submit(passage({ eventId: 'r3', result: 'denied', ts: T0 + 25 * SEC }));
    r.sup.submit(passage({ eventId: 'r4', result: 'denied', ts: T0 + 26 * SEC }));
    assert.equal(r.names().filter((n) => n === 'badge_denied_repeated').length, 1);
    r.sup.submit(passage({ eventId: 'r5', result: 'denied', ts: T0 + 27 * SEC }));
    assert.equal(r.names().filter((n) => n === 'badge_denied_repeated').length, 2);
  });

  it('2 refus seulement, ou 3 trop espaces : pas de pre-alarme', () => {
    const r = rig();
    r.sup.submit(passage({ eventId: 'a', result: 'denied', ts: T0 }));
    r.sup.submit(passage({ eventId: 'b', result: 'denied', ts: T0 + 1 }));
    r.sup.submit(passage({ eventId: 'c', result: 'denied', ts: T0 + 100 * SEC }));
    assert.equal(r.names().includes('badge_denied_repeated'), false);
  });

  it('refus d\'un evenement deja vu : compte une seule fois', () => {
    const r = rig();
    for (let i = 0; i < 5; i++) r.sup.submit(passage({ eventId: 'meme', result: 'denied', ts: T0 }));
    r.sup.submit(passage({ eventId: 'autre', result: 'denied', ts: T0 + SEC }));
    assert.equal(r.names().includes('badge_denied_repeated'), false, '2 refus distincts seulement');
    r.sup.submit(passage({ eventId: 'troisieme', result: 'denied', ts: T0 + 2 * SEC }));
    assert.equal(r.names().includes('badge_denied_repeated'), true);
  });

  it('un passage accepte ne remet pas le compteur a zero ; les portes sont independantes', () => {
    const r = rig();
    r.sup.submit(passage({ eventId: 'a', result: 'denied', ts: T0 }));
    r.sup.submit(passage({ eventId: 'ok1', result: 'granted', ts: T0 + SEC }));
    r.sup.submit(passage({ eventId: 'b', result: 'denied', ts: T0 + 2 * SEC }));
    r.sup.submit(passage({ eventId: 'autre-porte', doorNo: 2, result: 'denied', ts: T0 + 3 * SEC }));
    assert.equal(r.names().includes('badge_denied_repeated'), false);
    r.sup.submit(passage({ eventId: 'ok2', result: 'granted', ts: T0 + 4 * SEC }));
    r.sup.submit(passage({ eventId: 'c', result: 'denied', ts: T0 + 5 * SEC }));
    const reps = r.sent.filter((s) => s.msg.event === 'badge_denied_repeated');
    assert.equal(reps.length, 1);
    assert.equal(reps[0]!.id, 'PORTE-1');
  });

  it('refus differes (recuperes apres coupure) comptes comme les autres, dans le desordre', () => {
    const r = rig();
    r.sup.submit(passage({ eventId: 'a', result: 'denied', ts: T0 + 20 * SEC, deferred: true }));
    r.sup.submit(passage({ eventId: 'b', result: 'denied', ts: T0, deferred: true }));
    r.sup.submit(passage({ eventId: 'c', result: 'denied', ts: T0 + 10 * SEC, deferred: true }));
    assert.equal(r.sent.at(-1)!.msg.event, 'badge_denied_repeated');
    assert.equal(r.sent.at(-1)!.msg.ts, T0 + 10 * SEC);
  });

  it('seuil reglable', () => {
    const r = rig({ thresholds: { denied: { count: 2, windowS: 5 } } });
    r.sup.submit(passage({ eventId: 'a', result: 'denied', ts: T0 }));
    r.sup.submit(passage({ eventId: 'b', result: 'denied', ts: T0 + 6 * SEC }));
    assert.equal(r.names().includes('badge_denied_repeated'), false);
    r.sup.submit(passage({ eventId: 'c', result: 'denied', ts: T0 + 9 * SEC }));
    assert.equal(r.names().includes('badge_denied_repeated'), true);
  });

  it('un refus dont le message est refuse par le socle n\'est pas compte (il sera retente)', () => {
    const r = rig();
    r.sup.submit(passage({ eventId: 'a', result: 'denied', ts: T0 }));
    r.sup.submit(passage({ eventId: 'b', result: 'denied', ts: T0 + 1 }));
    r.accept.value = false;
    assert.equal(r.sup.submit(passage({ eventId: 'c', result: 'denied', ts: T0 + 2 }), ), 'refused');
    assert.equal(r.names().includes('badge_denied_repeated'), false);
    r.accept.value = true;
    assert.equal(r.sup.submit(passage({ eventId: 'c', result: 'denied', ts: T0 + 2 })), 'sent');
    assert.equal(r.names().at(-1), 'badge_denied_repeated');
  });

  it('badge_denied_repeated refuse par le socle : renvoye au tick suivant, une seule fois', () => {
    const r = rig();
    r.sup.alive();
    r.accept.only = (_id, msg) => msg.event !== 'badge_denied_repeated';
    for (let i = 0; i < 3; i++) r.sup.submit(passage({ eventId: `r${i}`, result: 'denied', ts: T0 + i }));
    assert.equal(r.names().includes('badge_denied_repeated'), false);
    assert.equal(r.sup.state().pendingRepeated, 1);
    r.sup.tick();
    assert.equal(r.names().includes('badge_denied_repeated'), false, 'toujours refuse');
    r.accept.only = undefined;
    r.sup.tick();
    assert.equal(r.names().filter((n) => n === 'badge_denied_repeated').length, 1);
    assert.equal(r.sup.state().pendingRepeated, 0);
    r.sup.tick();
    assert.equal(r.names().filter((n) => n === 'badge_denied_repeated').length, 1);
    assert.equal(r.sent.at(-1)!.msg.ts, T0 + 2, 'heure du refus declencheur');
  });

  it('donnees hostiles : le message reste conforme et accepte par prepare(), rien de personnel dans les journaux', () => {
    const r = rig();
    const hostile = [
      passage({ eventId: 'h1', holderName: { evil: true } as never, credential: ['x'] as never, holderRef: 12 as never }),
      passage({ eventId: 'h2', holderName: 'JEAN-SECRET DUPONT' + cp(0, 7) + 'Z'.repeat(100_000), credential: 'BADGE-SECRET-999/;' + '9'.repeat(5000) }),
      passage({ eventId: 'h3 espace/slash', holderName: EMOJI.repeat(500) }),
      passage({ eventId: 'h4', method: 'code', credential: 'PIN-4242' }),
      passage({ eventId: 'h5', ts: Number.NaN, holderName: 'JEAN-SECRET DUPONT', credential: 'BADGE-SECRET-999' }),
    ];
    for (const p of hostile) r.sup.submit(p);
    assert.equal(r.sent.length, 4);
    for (const s of r.sent) {
      const res = prepare(s.id, s.msg, T0);
      assert.equal(res.ok, true, JSON.stringify(res));
      assert.ok(Buffer.byteLength(JSON.stringify(s.msg)) <= 1024);
    }
    assert.equal(r.sent[3]!.msg.access?.credential, null);
    const journal = r.logs.map((l) => l.text).join('\n');
    for (const secret of ['SECRET', 'DUPONT', 'BADGE', '4242', 'PIN-']) assert.ok(!journal.includes(secret), `le journal contient ${secret}`);
  });
});

describe('acces-commun : superviseur - liaison, signes de vie, hors ligne', () => {
  it('premiere preuve de vie : un heartbeat par porte tout de suite, rien de plus ensuite', () => {
    const r = rig();
    r.sup.alive();
    assert.deepEqual(r.sent.map((s) => [s.id, s.msg]), [['PORTE-1', { event: 'heartbeat' }], ['PORTE-2', { event: 'heartbeat' }]]);
    r.sup.alive();
    r.sup.alive();
    assert.equal(r.sent.length, 2);
    assert.equal(r.sup.state().link, 'online');
    assert.equal(r.sup.state().lastAliveAt, T0);
  });

  it('heartbeats a la bonne cadence (60 s) tant que le controleur donne signe de vie', () => {
    const r = rig();
    r.sup.alive();
    r.advance(59 * SEC, SEC, true);
    assert.equal(r.names('PORTE-1').length, 1, 'rien avant 60 s');
    r.advance(SEC, SEC, true);
    assert.equal(r.names('PORTE-1').length, 2);
    assert.equal(r.clock.t, T0 + 60 * SEC);
    r.advance(125 * SEC, SEC, true);
    assert.deepEqual(r.names('PORTE-1'), ['heartbeat', 'heartbeat', 'heartbeat', 'heartbeat'], 't = 0, 60, 120, 180');
    assert.deepEqual(r.names('PORTE-2'), ['heartbeat', 'heartbeat', 'heartbeat', 'heartbeat']);
    // cadence reglable
    const q = rig({ thresholds: { heartbeatS: 10 } });
    q.sup.alive();
    q.advance(35 * SEC, SEC, true);
    assert.equal(q.names('PORTE-1').length, 4);
  });

  it('un tick tardif (veille de la machine) ne rattrape pas les heartbeats manques', () => {
    const r = rig();
    r.sup.alive();
    r.clock.t += 500 * SEC;
    r.sup.alive();
    r.sup.tick();
    assert.equal(r.names('PORTE-1').length, 2, 'un seul de plus');
  });

  it('coupure breve (retour avant la grace) : jamais offline, pas de heartbeat en plus', () => {
    const r = rig();
    r.sup.alive();
    const n = r.sent.length;
    r.clock.t += 5 * SEC;
    r.sup.linkLost('flux ferme');
    assert.equal(r.sup.state().link, 'lost');
    r.advance(10 * SEC);
    assert.equal(r.names().includes('offline'), false);
    r.sup.alive();
    assert.equal(r.sup.state().link, 'online');
    assert.equal(r.sup.state().lostSince, null);
    r.advance(40 * SEC, SEC, true);
    assert.equal(r.names().includes('offline'), false);
    assert.equal(r.sent.length, n, 'aucun message supplementaire dans les 50 s');
  });

  it('coupure : offline apres la grace (15 s), une seule fois par porte, sans repetition', () => {
    const r = rig();
    r.sup.alive();
    const base = r.sent.length;
    r.sup.linkLost('hote injoignable');
    r.advance(14_900, 100);
    assert.equal(r.sent.length, base, 'pas encore');
    r.advance(100, 100);
    assert.deepEqual(r.sent.slice(base).map((s) => [s.id, s.msg]), [['PORTE-1', { state: 'offline' }], ['PORTE-2', { state: 'offline' }]]);
    r.advance(600 * SEC);
    assert.equal(r.sent.length, base + 2, 'pas de repetition tant que la panne dure, pas de heartbeat');
    r.sup.linkLost('encore');
    r.sup.tick();
    assert.equal(r.sent.length, base + 2);
    assert.equal(r.sup.state().link, 'offline');
    assert.equal(r.sup.state().online, false);
    assert.equal(r.sup.state().lostReason, 'hote injoignable');
  });

  it('un nouvel appel a linkLost ne repousse pas l\'echeance', () => {
    const r = rig();
    r.sup.alive();
    r.sup.linkLost('a');
    r.advance(10 * SEC);
    r.sup.linkLost('b');
    r.advance(5 * SEC);
    assert.equal(r.names().filter((n) => n === 'offline').length, 2, 'offline apres 15 s en tout');
  });

  it('linkLost immediate : offline sans delai ni tick', () => {
    const r = rig();
    r.sup.alive();
    const base = r.sent.length;
    r.sup.linkLost('mot de passe refuse', { immediate: true });
    assert.deepEqual(r.names().slice(base), ['offline', 'offline']);
    r.sup.linkLost('encore', { immediate: true });
    r.advance(100 * SEC);
    assert.equal(r.sent.length, base + 2);
    // coupure en cours, puis immediate : on court-circuite la grace
    const q = rig();
    q.sup.alive();
    q.sup.linkLost('a');
    q.sup.linkLost('b', { immediate: true });
    assert.equal(q.names().filter((n) => n === 'offline').length, 2);
  });

  it('retour apres offline : heartbeat immediat pour chaque porte, rappel onOnline, puis un nouvel offline possible', () => {
    const calls: string[] = [];
    const clock = { t: T0 };
    const sent: Sent[] = [];
    const log = () => undefined;
    const sup = new ControllerSupervisor({
      controllerId: 'CTL-1',
      doors: new Map([[1, 'PORTE-1'], [2, 'PORTE-2']]),
      emit: (id, msg) => void sent.push({ id, msg }),
      now: () => clock.t,
      log,
      cursors: new CursorStore({ dir: tmp(), now: () => clock.t, log }),
      onOffline: (i) => calls.push(`off:${i.controllerId}:${i.reason}:${i.since - T0}`),
      onOnline: (i) => calls.push(`on:${i.controllerId}:${i.offlineForMs}`),
    });
    sup.alive();
    sup.linkLost('flux ferme');
    clock.t += 15 * SEC;
    sup.tick();
    assert.deepEqual(calls, ['off:CTL-1:flux ferme:0']);
    clock.t += 100 * SEC;
    const base = sent.length;
    sup.alive();
    assert.deepEqual(sent.slice(base).map((s) => [s.id, s.msg.event]), [['PORTE-1', 'heartbeat'], ['PORTE-2', 'heartbeat']]);
    assert.deepEqual(calls, ['off:CTL-1:flux ferme:0', 'on:CTL-1:100000']);
    // deuxieme panne : offline de nouveau (une fois)
    sup.linkLost('encore', { immediate: true });
    assert.equal(sent.filter((s) => s.msg.state === 'offline').length, 4);
    sup.tick();
    sup.tick();
    assert.equal(sent.filter((s) => s.msg.state === 'offline').length, 4);
  });

  it('rappels qui levent une exception : sans effet sur le superviseur', () => {
    const clock = { t: T0 };
    const sent: Sent[] = [];
    const logs: string[] = [];
    const sup = new ControllerSupervisor({
      controllerId: 'CTL-1',
      doors: new Map([[1, 'PORTE-1']]),
      emit: (id, msg) => void sent.push({ id, msg }),
      now: () => clock.t,
      log: (_l, t) => void logs.push(t),
      cursors: new CursorStore({ dir: tmp(), now: () => clock.t, log: () => undefined }),
      onOffline: () => {
        throw new Error('rappel casse');
      },
      onOnline: () => {
        throw new Error('rappel casse');
      },
    });
    sup.alive();
    assert.doesNotThrow(() => sup.linkLost('x', { immediate: true }));
    assert.doesNotThrow(() => sup.alive());
    assert.equal(sup.state().link, 'online');
    assert.ok(logs.some((l) => l.includes('rappel')));
  });

  it('controleur muet : plus de heartbeat, traite comme une coupure, offline apres la grace', () => {
    const r = rig();
    r.sup.alive();
    const base = r.sent.length;
    r.advance(30 * SEC); // exactement silenceMs : pas encore muet
    assert.equal(r.sup.state().link, 'online');
    r.advance(SEC);
    assert.equal(r.sup.state().link, 'lost');
    assert.equal(r.sup.state().lostReason, 'aucun signe de vie');
    assert.equal(r.sup.state().lostSince, T0 + 30 * SEC);
    assert.equal(r.sent.length, base);
    r.advance(13 * SEC); // t = +44 s : grace comptee depuis la fin du silence admis (30 s)
    assert.equal(r.sent.length, base, 'grace pas encore ecoulee a +44 s');
    r.advance(SEC);
    assert.deepEqual(r.names().slice(base), ['offline', 'offline']);
    r.advance(3600 * SEC, 10 * SEC);
    assert.equal(r.sent.length, base + 2, 'ni heartbeat ni repetition');
  });

  it('un controleur muet qui revient avant la grace : pas d\'offline', () => {
    const r = rig();
    r.sup.alive();
    r.advance(40 * SEC);
    assert.equal(r.sup.state().link, 'lost');
    r.sup.alive();
    r.advance(100 * SEC, SEC, true);
    assert.equal(r.names().includes('offline'), false);
  });

  it('jamais joint : traite comme une coupure au bout de 30 s, offline apres la grace ; premier alive = heartbeat', () => {
    const r = rig();
    r.advance(30 * SEC);
    assert.equal(r.sent.length, 0);
    r.advance(15 * SEC);
    assert.deepEqual(r.names(), ['offline', 'offline']);
    r.sup.alive();
    assert.deepEqual(r.names().slice(2), ['heartbeat', 'heartbeat']);
    // controleur jamais joint mais qui repond pendant la grace : heartbeat quand meme (premiere fois)
    const q = rig();
    q.advance(35 * SEC);
    assert.equal(q.sup.state().link, 'lost');
    q.sup.alive();
    assert.deepEqual(q.names(), ['heartbeat', 'heartbeat']);
  });

  it('linkLost avant toute preuve de vie : offline apres la grace', () => {
    const r = rig();
    r.sup.linkLost('connexion refusee');
    r.advance(14 * SEC);
    assert.equal(r.sent.length, 0);
    r.advance(SEC);
    assert.deepEqual(r.names(), ['offline', 'offline']);
  });

  it('offline refuse par le socle : retente au tick suivant jusqu\'a acceptation, puis plus jamais', () => {
    const r = rig();
    r.sup.alive();
    const base = r.sent.length;
    r.accept.value = false;
    r.sup.linkLost('x', { immediate: true });
    r.sup.tick();
    r.sup.tick();
    assert.equal(r.sent.length, base);
    r.accept.only = (id) => id === 'PORTE-1';
    r.accept.value = true;
    r.sup.tick();
    assert.deepEqual(r.sent.slice(base).map((s) => s.id), ['PORTE-1'], 'une porte acceptee');
    r.accept.only = undefined;
    r.sup.tick();
    assert.deepEqual(r.sent.slice(base).map((s) => s.id), ['PORTE-1', 'PORTE-2']);
    r.sup.tick();
    r.sup.tick();
    assert.equal(r.sent.length, base + 2);
  });

  it('motif de coupure hostile : nettoye et borne dans le journal et l\'etat', () => {
    const r = rig();
    r.sup.alive();
    r.sup.linkLost('erreur\nFAUX journal\r\n' + 'x'.repeat(5000) + cp(0, 7));
    const st = r.sup.state();
    assert.ok(st.lostReason !== null && st.lostReason.length <= 120);
    assert.ok(!/[\r\n\u0000]/.test(st.lostReason!));
    for (const l of r.logs) assert.ok(!/[\r\n]/.test(l.text));
    const q = rig();
    q.sup.linkLost({ objet: true } as never);
    assert.equal(q.sup.state().lostReason, null);
    q.sup.linkLost(undefined);
  });

  it('horloge de la passerelle revenue en arriere : pas de blocage', () => {
    const r = rig();
    r.sup.alive();
    r.clock.t -= 3600 * SEC;
    r.sup.tick();
    assert.equal(r.sup.state().link, 'online', 'rebase, pas de coupure fantome');
    r.advance(31 * SEC);
    assert.equal(r.sup.state().link, 'lost');
    r.advance(15 * SEC);
    assert.equal(r.names().filter((n) => n === 'offline').length, 2);
    // une coupure commencee avant le saut en arriere
    const q = rig();
    q.sup.alive();
    q.sup.linkLost('x');
    q.clock.t -= 3600 * SEC;
    q.advance(16 * SEC);
    assert.equal(q.names().filter((n) => n === 'offline').length, 2);
  });
});

describe('acces-commun : superviseur - evenements de porte et de sabotage', () => {
  const MAP: Array<[DoorEventKind, string]> = [
    ['opened', 'door_opened'],
    ['closed', 'door_closed'],
    ['forced', 'door_forced'],
    ['held_open', 'door_held_open'],
    ['held_open_end', 'door_closed'],
    ['tamper', 'tamper'],
    ['tamper_end', 'restored'],
  ];

  it('chaque nature est traduite en evenement PSIM, msgId deterministe, ts du controleur', () => {
    for (const [kind, psim] of MAP) {
      const r = rig();
      assert.equal(r.sup.doorEvent(2, kind, T0 + 7, 'rec9'), true, kind);
      assert.equal(r.sent.length, 1, kind);
      assert.equal(r.sent[0]!.id, 'PORTE-2');
      assert.deepEqual(r.sent[0]!.msg, { event: psim, ts: T0 + 7, msgId: `acc:CTL-1:${kind}-2-${T0 + 7}-rec9` }, kind);
      // meme evenement rejoue : meme msgId
      r.sup.doorEvent(2, kind, T0 + 7, 'rec9');
      assert.equal(r.sent[1]!.msg.msgId, r.sent[0]!.msg.msgId, kind);
      // evenement distinct : msgId distinct
      r.sup.doorEvent(2, kind, T0 + 8, 'rec9');
      r.sup.doorEvent(2, kind, T0 + 7, 'rec10');
      r.sup.doorEvent(1, kind, T0 + 7, 'rec9');
      const ids = new Set(r.sent.map((s) => `${s.id}|${s.msg.msgId}`));
      assert.equal(ids.size, 4, kind);
      // le socle l'accepte
      assert.equal(prepare(r.sent[0]!.id, r.sent[0]!.msg, T0).ok, true);
    }
  });

  it('etats memorises : ouverte, forcee, maintenue, fermee', () => {
    const r = rig();
    const st = () => r.sup.state().doors[0]!;
    r.sup.doorEvent(1, 'opened', T0 + 1);
    assert.equal(st().open, true);
    r.sup.doorEvent(1, 'forced', T0 + 2);
    assert.equal(st().forced, true);
    r.sup.doorEvent(1, 'held_open', T0 + 3);
    assert.equal(st().held, true);
    r.sup.doorEvent(1, 'tamper', T0 + 4);
    assert.equal(st().tamper, true);
    r.sup.doorEvent(1, 'closed', T0 + 5);
    assert.deepEqual(st(), { doorNo: 1, detectorId: 'PORTE-1', open: false, forced: false, held: false, tamper: true, drift: false });
    r.sup.doorEvent(1, 'held_open', T0 + 6);
    r.sup.doorEvent(1, 'held_open_end', T0 + 7);
    assert.equal(st().held, false);
    assert.equal(st().open, false);
    assert.equal(r.sup.state().doors[1]!.open, null, 'l\'autre porte n\'est pas touchee');
  });

  it('sabotage du boitier : toutes les portes ; fin = restored partout', () => {
    const r = rig();
    assert.equal(r.sup.controllerEvent('tamper', T0, 'x1'), true);
    assert.deepEqual(r.sent.map((s) => [s.id, s.msg.event]), [['PORTE-1', 'tamper'], ['PORTE-2', 'tamper']]);
    assert.equal(r.sup.state().doors.every((d) => d.tamper), true);
    assert.equal(r.sup.controllerEvent('tamper_end', T0 + SEC, 'x2'), true);
    assert.deepEqual(r.sent.slice(2).map((s) => [s.id, s.msg.event]), [['PORTE-1', 'restored'], ['PORTE-2', 'restored']]);
    assert.equal(r.sup.state().doors.some((d) => d.tamper), false);
    assert.equal(r.sup.controllerEvent('autre' as never, T0), false);
  });

  it('fin de sabotage sur une porte encore forcee, maintenue ou en derive : pas de restored', () => {
    const r = rig();
    r.sup.doorEvent(2, 'forced', T0);
    r.sup.controllerEvent('tamper', T0 + 1);
    r.sent.length = 0;
    assert.equal(r.sup.controllerEvent('tamper_end', T0 + 2), true);
    assert.deepEqual(r.sent.map((s) => [s.id, s.msg.event]), [['PORTE-1', 'restored']], 'PORTE-2 est toujours forcee');
    assert.equal(r.sup.state().doors[1]!.tamper, false);
    // la fermeture de la porte 2 ramene le retour a la normale
    r.sup.doorEvent(2, 'closed', T0 + 3);
    assert.equal(r.sent.at(-1)!.msg.event, 'door_closed');
    // maintenue ouverte
    const h = rig();
    h.sup.doorEvent(1, 'held_open', T0);
    h.sup.doorEvent(1, 'tamper', T0 + 1);
    h.sent.length = 0;
    assert.equal(h.sup.doorEvent(1, 'tamper_end', T0 + 2), true);
    assert.equal(h.sent.length, 0);
    // derive d'horloge active
    const d = rig();
    d.sup.alive();
    d.sup.deviceTime(T0 + 10 * 60 * SEC);
    d.sup.doorEvent(1, 'tamper', T0 + 1);
    d.sent.length = 0;
    assert.equal(d.sup.doorEvent(1, 'tamper_end', T0 + 2), true);
    assert.equal(d.sent.length, 0);
  });

  it('evenements plus anciens que le dernier changement (desordre) : transmis mais sans effet sur les etats memorises, et sans effacer une alarme en cours', () => {
    const r = rig();
    r.sup.doorEvent(1, 'forced', T0 + 200);
    r.sent.length = 0;
    assert.equal(r.sup.doorEvent(1, 'closed', T0 + 100), true);
    assert.equal(r.sent.length, 0, 'une fermeture plus ancienne n\'efface pas le forcage en cours');
    assert.equal(r.sup.state().doors[0]!.forced, true);
    assert.equal(r.sup.doorEvent(1, 'opened', T0 + 150), true);
    assert.equal(r.sent.length, 1, 'une ouverture ancienne est transmise');
    assert.equal(r.sup.state().doors[0]!.forced, true);
    // sabotage: fin de sabotage ancienne apres un nouveau sabotage
    const t = rig();
    t.sup.doorEvent(1, 'tamper', T0 + 50);
    t.sent.length = 0;
    t.sup.doorEvent(1, 'tamper_end', T0 + 10);
    assert.equal(t.sent.length, 0);
    assert.equal(t.sup.state().doors[0]!.tamper, true);
    // la vraie fin arrive ensuite
    t.sup.doorEvent(1, 'tamper_end', T0 + 60);
    assert.equal(t.sent.at(-1)!.msg.event, 'restored');
    assert.equal(t.sup.state().doors[0]!.tamper, false);
  });

  it('porte inconnue : ignoree avec un journal limite, resultat faux', () => {
    const r = rig();
    for (let i = 0; i < 50; i++) assert.equal(r.sup.doorEvent(7, 'forced', T0 + i), false);
    assert.equal(r.sent.length, 0);
    assert.equal(r.logs.filter((l) => l.text.includes('porte inconnue')).length, 1);
    assert.equal(r.sup.doorEvent(Number.NaN, 'forced', T0), false);
    assert.equal(r.sup.doorEvent('1' as never, 'forced', T0), false);
  });

  it('nature inconnue ou heure invalide', () => {
    const r = rig();
    assert.equal(r.sup.doorEvent(1, 'explose' as never, T0), false);
    assert.equal(r.sup.doorEvent(1, 'constructor' as never, T0), false);
    assert.equal(r.sup.doorEvent(1, '__proto__' as never, T0), false);
    assert.equal(r.sent.length, 0);
    r.clock.t = T0 + 5;
    assert.equal(r.sup.doorEvent(1, 'forced', Number.NaN), true);
    assert.equal(r.sent[0]!.msg.ts, T0 + 5, 'heure de la passerelle a defaut');
    assert.equal(r.sup.doorEvent(1, 'opened', 1_760_000_000), true, 'secondes : meme traitement');
    assert.equal(r.sent[1]!.msg.ts, T0 + 5);
  });

  it('evenement refuse par le socle : faux (a retenter)', () => {
    const r = rig();
    r.accept.value = false;
    assert.equal(r.sup.doorEvent(1, 'forced', T0), false);
    assert.equal(r.sup.controllerEvent('tamper', T0), false);
    r.accept.value = true;
    assert.equal(r.sup.doorEvent(1, 'forced', T0), true);
  });
});

describe('acces-commun : superviseur - horloge du controleur', () => {
  const MIN = 60 * SEC;

  it('ecart superieur a 2 min : clock_drift pour chaque porte, une seule fois, ecart signe rendu', () => {
    const r = rig();
    r.sup.alive();
    r.sent.length = 0;
    assert.equal(r.sup.deviceTime(T0 + 3 * MIN), 3 * MIN);
    assert.deepEqual(r.sent.map((s) => [s.id, s.msg.event, s.msg.ts]), [['PORTE-1', 'clock_drift', T0], ['PORTE-2', 'clock_drift', T0]]);
    assert.equal(r.sent[0]!.msg.msgId, `acc:CTL-1:clock_drift-1-${T0}`);
    assert.equal(r.sup.state().drifting, true);
    assert.equal(r.sup.state().lastDriftMs, 3 * MIN);
    assert.equal(r.sup.state().doors.every((d) => d.drift), true);
    assert.equal(prepare('PORTE-1', r.sent[0]!.msg, T0).ok, true);
    // appels rapproches : pas de repetition
    r.clock.t += 60 * SEC;
    assert.equal(r.sup.deviceTime(r.clock.t + 3 * MIN), 3 * MIN);
    assert.equal(r.sent.length, 2);
  });

  it('exactement 2 min : pas encore un defaut ; en retard (negatif) aussi detecte', () => {
    const r = rig();
    r.sup.alive();
    r.sent.length = 0;
    assert.equal(r.sup.deviceTime(T0 + 2 * MIN), 2 * MIN);
    assert.equal(r.sent.length, 0);
    assert.equal(r.sup.deviceTime(T0 - 2 * MIN), -2 * MIN);
    assert.equal(r.sent.length, 0);
    assert.equal(r.sup.deviceTime(T0 - 2 * MIN - 1), -2 * MIN - 1);
    assert.equal(r.sent.length, 2);
    assert.equal(r.sup.state().drifting, true);
  });

  it('heure de lecture fournie : l\'ecart se calcule sur elle', () => {
    const r = rig();
    r.sup.alive();
    assert.equal(r.sup.deviceTime(T0 + 10_000, T0 + 4_000), 6_000);
    assert.equal(r.sup.deviceTime(T0, Number.NaN), 0, 'instant de lecture inutilisable : heure courante');
  });

  it('defaut qui dure : repete toutes les 300 s (par deviceTime ou par tick), pas avant', () => {
    const r = rig();
    r.sup.alive();
    r.sent.length = 0;
    r.sup.deviceTime(T0 + 5 * MIN);
    assert.equal(r.sent.length, 2);
    r.advance(299 * SEC, SEC, true);
    assert.equal(r.sent.filter((s) => s.msg.event === 'clock_drift').length, 2);
    r.advance(SEC, SEC, true);
    assert.equal(r.sent.filter((s) => s.msg.event === 'clock_drift').length, 4, 'par tick, a +300 s');
    // et par deviceTime aussi
    r.advance(299 * SEC, SEC, true);
    assert.equal(r.sent.filter((s) => s.msg.event === 'clock_drift').length, 4);
    r.clock.t += SEC;
    r.sup.alive();
    r.sup.deviceTime(r.clock.t + 5 * MIN);
    assert.equal(r.sent.filter((s) => s.msg.event === 'clock_drift').length, 6);
    // deux ts distincts => deux msgId distincts
    const ids = r.sent.filter((s) => s.id === 'PORTE-1' && s.msg.event === 'clock_drift').map((s) => s.msg.msgId);
    assert.equal(new Set(ids).size, 3);
  });

  it('retour sous 1 min (driftMs / 2) : restored pour chaque porte ; entre 1 et 2 min rien ne change', () => {
    const r = rig();
    r.sup.alive();
    r.sup.deviceTime(T0 + 5 * MIN);
    r.sent.length = 0;
    r.sup.deviceTime(T0 + 90 * SEC);
    assert.equal(r.sent.length, 0, 'entre les deux seuils : hysteresis');
    assert.equal(r.sup.state().drifting, true);
    r.sup.deviceTime(T0 + 61 * SEC);
    assert.equal(r.sent.length, 0);
    assert.equal(r.sup.deviceTime(T0 + 60 * SEC), 60 * SEC);
    assert.deepEqual(r.sent.map((s) => [s.id, s.msg.event]), [['PORTE-1', 'restored'], ['PORTE-2', 'restored']]);
    assert.equal(r.sup.state().drifting, false);
    assert.equal(r.sup.state().doors.some((d) => d.drift), false);
    // plus de repetition ensuite
    r.advance(1000 * SEC, 5 * SEC, true);
    assert.equal(r.sent.filter((s) => s.msg.event === 'clock_drift').length, 0);
    assert.equal(r.sent.filter((s) => s.msg.event === 'restored').length, 2);
    // une nouvelle derive est de nouveau signalee
    r.sup.deviceTime(r.clock.t + 10 * MIN);
    assert.equal(r.sent.filter((s) => s.msg.event === 'clock_drift').length, 2);
  });

  it('un ecart toujours sous 2 min sans derive en cours : aucun message', () => {
    const r = rig();
    r.sup.alive();
    r.sent.length = 0;
    r.sup.deviceTime(T0 + 30 * SEC);
    r.sup.deviceTime(T0 + 100 * SEC);
    assert.equal(r.sent.length, 0);
    assert.equal(r.sup.state().drifting, false);
  });

  it('une porte forcee, maintenue ouverte ou sabotee : pas de restored au retour de l\'horloge', () => {
    const r = rig();
    r.sup.alive();
    r.sup.doorEvent(2, 'forced', T0);
    r.sup.deviceTime(T0 + 5 * MIN);
    r.sent.length = 0;
    r.sup.deviceTime(T0);
    assert.deepEqual(r.sent.map((s) => [s.id, s.msg.event]), [['PORTE-1', 'restored']], 'PORTE-2 reste en alarme');
    // plus tard, la fermeture de la porte 2 donne son retour a la normale
    r.sup.doorEvent(2, 'closed', T0 + SEC);
    assert.equal(r.sent.at(-1)!.msg.event, 'door_closed');
    // sabotage et maintien
    for (const kind of ['tamper', 'held_open'] as const) {
      const q = rig();
      q.sup.alive();
      q.sup.doorEvent(1, kind, T0);
      q.sup.deviceTime(T0 + 5 * MIN);
      q.sent.length = 0;
      q.sup.deviceTime(T0);
      assert.deepEqual(q.sent.map((s) => [s.id, s.msg.event]), [['PORTE-2', 'restored']], kind);
    }
  });

  it('heures aberrantes ignorees : null, aucun message, aucun changement', () => {
    const r = rig();
    r.sup.alive();
    r.sent.length = 0;
    for (const bad of [Number.NaN, 0, -5, Infinity, -Infinity, '1760000000000' as never, null as never, undefined as never, {} as never, 1e17]) assert.equal(r.sup.deviceTime(bad), null, String(bad));
    assert.equal(r.sent.length, 0);
    assert.equal(r.sup.state().drifting, false);
    assert.equal(r.sup.state().lastDriftMs, null);
    assert.equal(r.logs.filter((l) => l.text.includes('aberrante')).length, 1, 'journal limite');
    // pendant une derive, une heure aberrante ne la fait pas disparaitre
    r.sup.deviceTime(T0 + 5 * MIN);
    r.sent.length = 0;
    assert.equal(r.sup.deviceTime(Number.NaN), null);
    assert.equal(r.sup.state().drifting, true);
    assert.equal(r.sent.length, 0);
    // une date tres ancienne (horloge reinitialisee) est bien un defaut
    const q = rig();
    q.sup.alive();
    assert.equal(q.sup.deviceTime(946_684_800_000), 946_684_800_000 - T0);
    assert.equal(q.sup.state().drifting, true);
  });

  it('clock_drift refuse par le socle : retente au tick suivant', () => {
    const r = rig();
    r.sup.alive();
    r.sent.length = 0;
    r.accept.value = false;
    r.sup.deviceTime(T0 + 5 * MIN);
    assert.equal(r.sent.length, 0);
    r.sup.tick();
    assert.equal(r.sent.length, 0);
    r.accept.value = true;
    r.clock.t += SEC;
    r.sup.alive();
    r.sup.tick();
    assert.deepEqual(r.sent.map((s) => [s.id, s.msg.event]), [['PORTE-1', 'clock_drift'], ['PORTE-2', 'clock_drift']]);
    r.sup.alive();
    r.sup.tick();
    assert.equal(r.sent.length, 2, 'une seule fois');
  });

  it('pas de clock_drift tant que le controleur est hors ligne (tick)', () => {
    const r = rig();
    r.sup.alive();
    r.sup.deviceTime(T0 + 5 * MIN);
    r.sent.length = 0;
    r.sup.linkLost('x', { immediate: true });
    r.sent.length = 0;
    r.advance(1000 * SEC, 10 * SEC);
    assert.equal(r.sent.filter((s) => s.msg.event === 'clock_drift').length, 0);
  });

  it('driftDue : a la premiere connexion, toutes les 300 s, a chaque reconnexion, jamais hors ligne', () => {
    const r = rig();
    assert.equal(r.sup.driftDue(), false, 'hors ligne');
    r.sup.alive();
    assert.equal(r.sup.driftDue(), true, 'premiere connexion');
    assert.equal(r.sup.driftDue(), true, 'reste vrai tant que deviceTime n\'est pas appelee');
    r.sup.deviceTime(T0);
    assert.equal(r.sup.driftDue(), false);
    r.advance(299 * SEC, SEC, true);
    assert.equal(r.sup.driftDue(), false);
    r.advance(SEC, SEC, true);
    assert.equal(r.sup.driftDue(), true);
    r.sup.deviceTime(r.clock.t);
    assert.equal(r.sup.driftDue(), false);
    // reconnexion apres coupure
    r.sup.linkLost('x', { immediate: true });
    assert.equal(r.sup.driftDue(), false);
    r.advance(5 * SEC);
    r.sup.alive();
    assert.equal(r.sup.driftDue(), true);
    r.sup.deviceTime(r.clock.t);
    assert.equal(r.sup.driftDue(), false);
    // coupure brave (sans offline) puis retour : on relit l'heure aussi
    r.sup.linkLost('flux');
    r.advance(3 * SEC);
    r.sup.alive();
    assert.equal(r.sup.driftDue(), true);
    // horloge de la passerelle revenue en arriere
    r.sup.deviceTime(r.clock.t);
    r.clock.t -= 3600 * SEC;
    r.sup.alive();
    assert.equal(r.sup.driftDue(), true);
  });
});

describe('acces-commun : superviseur - etat, contrat et garde-fous', () => {
  it('state() : compteurs et portes, sans donnee personnelle', () => {
    const r = rig();
    r.sup.alive();
    r.sup.submit(passage({ holderName: 'NOM PERSONNEL', credential: 'BADGE-77' }));
    r.accept.value = false;
    r.sup.submit(passage({ eventId: 'z' }));
    const st = r.sup.state();
    assert.equal(st.emitted, 3);
    assert.equal(st.refused, 1);
    assert.equal(st.controllerId, 'CTL-1');
    const json = JSON.stringify(st);
    assert.ok(!json.includes('NOM PERSONNEL') && !json.includes('BADGE-77'));
  });

  it('tous les evenements emis sont connus du PSIM et acceptes par prepare() (parcours complet)', () => {
    const r = rig();
    r.sup.alive();
    r.sup.submit(passage({ eventId: 'a', cursor: '1' }));
    for (let i = 0; i < 3; i++) r.sup.submit(passage({ eventId: `d${i}`, result: 'denied', reason: 'disabled', ts: T0 + i }));
    for (const [k] of [['opened'], ['closed'], ['forced'], ['held_open'], ['held_open_end'], ['tamper'], ['tamper_end']] as const) r.sup.doorEvent(1, k, T0 + 10);
    r.sup.controllerEvent('tamper', T0 + 11);
    r.sup.deviceTime(T0 + 10 * 60 * SEC);
    r.sup.deviceTime(T0);
    r.sup.linkLost('x', { immediate: true });
    r.sup.alive();
    assert.ok(r.sent.length > 15);
    for (const s of r.sent) {
      const res = prepare(s.id, s.msg, T0);
      assert.equal(res.ok, true, JSON.stringify(s.msg));
      if (res.ok) assert.ok(res.warnings.every((w) => w.includes('access')), res.warnings.join(' | '));
    }
  });

  it('dossier acces-commun : pas un module de passerelle (moduleEntry ne le charge pas, pas d\'index.ts)', () => {
    assert.equal(moduleEntry('acces-commun', MODULES_DIR), null);
    assert.equal(existsSync(join(MODULES_DIR, 'acces-commun', 'index.ts')), false);
    assert.equal(existsSync(join(MODULES_DIR, 'acces-commun', 'commun.ts')), true);
  });

  it('aucun temporisateur ni dependance hors node: dans le code commun', () => {
    const dir = join(MODULES_DIR, 'acces-commun');
    const mine = ['commun.ts', 'types.ts', 'messages.ts', 'denials.ts', 'cursor.ts', 'limitedlog.ts', 'supervisor.ts'];
    for (const f of mine) {
      const src = readFileSync(resolve(dir, f), 'utf8');
      assert.ok(!/\bset(Timeout|Interval|Immediate)\b/.test(src), `${f} : pas de temporisateur`);
      assert.ok(!/\bDate\.now\b|\bnew Date\b/.test(src), `${f} : pas d'horloge globale`);
      for (const m of src.matchAll(/^import\s[^'"]*['"]([^'"]+)['"]/gm)) {
        const from = m[1]!;
        assert.ok(from.startsWith('node:') || from.startsWith('./') || from === '../../module.ts' || from === '../../msgid.ts', `${f} : import ${from}`);
      }
    }
  });
});
