/**
 * Module `acces-dahua` : traduction du protocole (donnees hostiles comprises), configuration, requetes Digest, pilote de porte,
 * et flux complet contre un FAUX controleur local (gateway/test/fake-dahua.ts, 127.0.0.1, aucun materiel reel). L'horloge du module
 * est injectee (`now` manuel) ; seules les entrees-sorties locales prennent du temps reel.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, afterEach, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import type { DeviceMessage, ModuleContext } from '../src/module.ts';
import { ActuatorFailure, makeActuatorHandler } from '../src/modules/acces-commun/actuator.ts';
import type { ActuatorHandler } from '../src/modules/acces-commun/actuator.ts';
import { passageMessage } from '../src/modules/acces-commun/commun.ts';
import { DEFAULT_THRESHOLDS, parseConfig } from '../src/modules/acces-dahua/config.ts';
import type { Timers } from '../src/modules/acces-dahua/controller.ts';
import { DahuaDoorDriver } from '../src/modules/acces-dahua/driver.ts';
import { AuthGate, AUTH_BLOCK_MS, DahuaAuthError, DahuaHttp, DahuaHttpError } from '../src/modules/acces-dahua/http.ts';
import { createModule } from '../src/modules/acces-dahua/index.ts';
import type { AccesDahuaModule } from '../src/modules/acces-dahua/index.ts';
import {
  ERROR_REASONS,
  METHODS,
  parseCurrentTime,
  parseDoorMode,
  parseDoorStatus,
  parsePart,
  parseRecordPage,
  translateEvent,
  translateRecord,
} from '../src/modules/acces-dahua/protocol.ts';
import type { TranslateContext, Translation } from '../src/modules/acces-dahua/protocol.ts';
import { KNOWN_EVENTS, prepare } from '../src/validate.ts';
import { FakeDahua } from './fake-dahua.ts';
import type { AccessInput, FakeDahuaOptions } from './fake-dahua.ts';
import { ROOT, sleep, tempDir, waitFor } from './helpers.ts';

const T0 = Date.UTC(2026, 9, 17, 10, 0, 0);
/** Caractere d'ecriture inversee (U+202E), ecrit par son code pour eviter toute transformation par les outils. */
const RLO = String.fromCodePoint(0x202e);
const cleanup: (() => unknown)[] = [];
const allLogs: string[] = [];
const unhandled: unknown[] = [];
process.on('unhandledRejection', (reason) => void unhandled.push(reason));

afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) {
    try {
      await f();
    } catch {
      // nettoyage au mieux
    }
  }
});

after(() => {
  assert.deepEqual(unhandled, [], 'aucune promesse rejetee sans gestionnaire');
});

// ---------------------------------------------------------------------------------------------------------------------------
// Protocole (pur)
// ---------------------------------------------------------------------------------------------------------------------------

const CTX: TranslateContext = { utcOffsetMin: 0, receivedAt: T0, doorBase: 0, doorNos: [1, 2] };
const ASI_SAMPLE = `Code=AccessControl;action=Pulse;index=0;data={
   "CardName" : "",
   "CardNo" : "12EA3004",
   "CardType" : 0,
   "CreateTime" : 1629721071,
   "Door" : 0,
   "ErrorCode" : 0,
   "Method" : 1,
   "ReaderID" : "1",
   "Status" : 1,
   "Type" : "Entry",
   "UTC" : 1629721071,
   "UserID" : "1",
   "UserType" : 0
}`;

function part(code: string, action: string, index: number, data: unknown): string {
  return `Code=${code};action=${action};index=${index}${data === undefined ? '' : `;data=${typeof data === 'string' ? data : JSON.stringify(data, null, 2)}`}`;
}

function tr(body: string, ctx: TranslateContext = CTX): Translation {
  const ev = parsePart(body);
  assert.ok(ev, `partie illisible : ${body.slice(0, 60)}`);
  return translateEvent(ev, ctx);
}

function passageOf(t: Translation) {
  assert.equal(t.kind, 'passage', JSON.stringify(t).slice(0, 200));
  return (t as Extract<Translation, { kind: 'passage' }>).passage;
}

describe('acces-dahua : protocole', () => {
  it("evenement reel d'un terminal ASI (sans RecNo) : passage accepte, entree, identifiant synthetique deterministe", () => {
    const a = tr(ASI_SAMPLE, { ...CTX, receivedAt: 1629721075000 });
    const p = passageOf(a);
    assert.equal((a as { recNo: string | null }).recNo, null);
    assert.equal(p.result, 'granted');
    assert.equal(p.reason, null);
    assert.equal(p.method, 'badge');
    assert.equal(p.direction, 'in');
    assert.equal(p.credential, '12EA3004');
    assert.equal(p.holderName, null, 'CardName vide : aucun nom');
    assert.equal(p.holderRef, '1');
    assert.equal(p.doorNo, 1);
    assert.equal(p.ts, 1629721071000);
    assert.match(p.eventId, /^x1629721071\.1\.[0-9a-f]{8}$/);
    assert.equal(p.cursor, undefined, 'sans RecNo, pas de curseur');
    assert.equal(passageOf(tr(ASI_SAMPLE, { ...CTX, receivedAt: 1629721099000 })).eventId, p.eventId, 'meme evenement, meme identifiant');
    // Le message du code commun l'accepte, et le socle aussi.
    const msg = passageMessage('CTL-1', p);
    assert.equal(prepare('P-ENTREE', msg, T0).ok, true);
  });

  it('evenement avec RecNo et UTC flottant : le n° d\'enregistrement devient eventId et curseur', () => {
    const p = passageOf(tr(part('AccessControl', 'Pulse', 1, { CardNo: 'bd08f6fa', Method: 1, Name: 'OpenDoor', RecNo: 4, Status: 1, Type: 'Exit', UTC: 1628253271.0, UserID: '1405', ReaderID: '1' })));
    assert.equal(p.eventId, '4');
    assert.equal(p.cursor, '4');
    assert.equal(p.doorNo, 2, 'sans champ Door, l\'index du flux (1) donne la porte 2');
    assert.equal(p.direction, 'out');
    assert.equal(p.ts, 1628253271000);
    assert.equal(p.holderName, null, '`Name` est le nom de l\'action, pas celui d\'une personne');
  });

  it('table Method : confirmee 0 / 1 / 2 / 3 / 6 / 15, deduite 4 et 5, tout le reste « unknown »', () => {
    const want: Record<number, string> = { 0: 'code', 1: 'badge', 2: 'badge', 3: 'badge', 4: 'remote', 5: 'exit_button', 6: 'fingerprint', 15: 'face' };
    for (const [m, expected] of Object.entries(want)) {
      assert.equal(passageOf(tr(part('AccessControl', 'Pulse', 0, { Method: Number(m), CardNo: '1', UTC: 1700000000 }))).method, expected, `Method ${m}`);
    }
    for (const m of [7, 8, 9, 14, 16, 99, -1, 1.5, '1.5', 'abc', null, true, {}, [], 1e12]) {
      assert.equal(passageOf(tr(part('AccessControl', 'Pulse', 0, { Method: m, CardNo: '1', UTC: 1700000000 }))).method, 'unknown', `Method ${JSON.stringify(m)}`);
    }
    assert.equal(passageOf(tr(part('AccessControl', 'Pulse', 0, { CardNo: '1', UTC: 1700000000 }))).method, 'unknown', 'Method absent');
    assert.equal(Object.keys(METHODS).length, 8);
    assert.equal(passageOf(tr(part('AccessControl', 'Pulse', 0, { Method: '6', CardNo: '1', UTC: 1700000000 }))).method, 'fingerprint', 'nombre ecrit en texte');
  });

  it('Status : absent = accepte ; 1 = accepte ; 0 = refuse avec motif ; toute autre valeur = refus (jamais d\'acces suppose)', () => {
    const base = { CardNo: '1', Method: 1, UTC: 1700000000 };
    assert.equal(passageOf(tr(part('AccessControl', 'Pulse', 0, base))).result, 'granted');
    assert.equal(passageOf(tr(part('AccessControl', 'Pulse', 0, { ...base, Status: 1 }))).result, 'granted');
    assert.equal(passageOf(tr(part('AccessControl', 'Pulse', 0, { ...base, Status: '1' }))).result, 'granted');
    for (const s of [0, '0', 2, -1, 'oui', true, {}, []]) {
      const p = passageOf(tr(part('AccessControl', 'Pulse', 0, { ...base, Status: s })));
      assert.equal(p.result, 'denied', `Status ${JSON.stringify(s)}`);
      assert.notEqual(p.reason, null);
    }
    assert.equal(passageOf(tr(part('AccessControl', 'Pulse', 0, { ...base, Status: null }))).result, 'granted', 'null = absent');
  });

  it('ErrorCode -> motif de refus (table A QUALIFIER) ; valeur inconnue = other ; chaine hexadecimale acceptee', () => {
    const reason = (ErrorCode: unknown, extra: object = {}) => passageOf(tr(part('AccessControl', 'Pulse', 0, { CardNo: '1', Method: 1, Status: 0, ErrorCode, UTC: 1700000000, ...extra }))).reason;
    assert.equal(reason(0x10), 'unknown_credential');
    assert.equal(reason(0x11), 'disabled');
    assert.equal(reason(0x14), 'expired');
    assert.equal(reason(0x15), 'antipassback');
    assert.equal(reason(0x17), 'door_locked');
    assert.equal(reason(0x20), 'out_of_schedule');
    assert.equal(reason('0x15'), 'antipassback');
    assert.equal(reason(21), 'antipassback', 'decimal : 21 = 0x15');
    assert.equal(reason(0x65), 'other', 'temperature elevee');
    assert.equal(reason(0x66), 'other', 'sans masque');
    for (const v of [0x13, 0x16, 0x77, 9999, -5, 'zz', null, {}, 1e20]) assert.equal(reason(v), 'other', JSON.stringify(v));
    assert.equal(reason(0, { Method: 0 }), 'wrong_pin', 'refus sans code lors d\'une saisie de code : mauvais code');
    assert.equal(reason(0), 'other');
    for (const r of Object.values(ERROR_REASONS)) assert.ok(['unknown_credential', 'expired', 'out_of_schedule', 'disabled', 'wrong_pin', 'antipassback', 'door_locked', 'other'].includes(r));
  });

  it('sens : Entry / Exit (sans tenir compte de la casse), sinon null', () => {
    const dir = (Type: unknown) => passageOf(tr(part('AccessControl', 'Pulse', 0, { CardNo: '1', Type, UTC: 1700000000 }))).direction;
    assert.equal(dir('Entry'), 'in');
    assert.equal(dir('exit'), 'out');
    assert.equal(dir(' EXIT '), 'out');
    for (const v of [undefined, null, '', 'Both', 1, {}, 'Entry; DROP']) assert.equal(dir(v), null);
  });

  it('JAMAIS de code PIN : ni dans le passage, ni dans le message, quelle que soit la methode', () => {
    for (const method of [0, 1, 2, 3, 6, 15, 99]) {
      const t = tr(part('AccessControl', 'Pulse', 0, { CardNo: '5551234', Method: method, Password: 'PIN-9876', RecNo: 12, Status: 1, UTC: 1700000000, UserID: 'u1', Pwd: 'PIN-9876', PassWord: 'PIN-9876' }));
      const p = passageOf(t);
      assert.equal(JSON.stringify(t).includes('9876'), false, `methode ${method}`);
      const msg = passageMessage('CTL-1', p);
      assert.equal(JSON.stringify(msg).includes('9876'), false);
      if (method === 0) assert.equal(p.credential, null, 'mode code : credential = null');
    }
    // Un enregistrement de la memoire : meme chose.
    const t = translateRecord({ RecNo: '3', CardNo: '5551234', Method: '0', Status: '1', CreateTime: '1700000000' }, { ...CTX, doorNos: [1] });
    assert.equal(passageOf(t).credential, null);
    const page = parseRecordPage('totalCount=1\r\nfound=1\r\nrecords[0].RecNo=3\r\nrecords[0].Password=PIN-9876\r\nrecords[0].CardNo=1\r\n');
    assert.equal(JSON.stringify(page).includes('9876'), false, 'le champ Password n\'est meme pas conserve');
  });

  it('heure de l\'evenement : UTC (secondes, flottant, millisecondes), CreateTime, heure locale + utcOffsetMin, sinon reception', () => {
    const at = (data: object, ctx: TranslateContext = CTX) => passageOf(tr(part('AccessControl', 'Pulse', 0, { CardNo: '1', ...data }), ctx)).ts;
    assert.equal(at({ UTC: 1760000000 }), 1760000000000);
    assert.equal(at({ UTC: 1760000000.6 }), 1760000000600);
    assert.equal(at({ UTC: 1760000000123 }), 1760000000123, 'deja en millisecondes');
    assert.equal(at({ UTC: '1760000000' }), 1760000000000);
    assert.equal(at({ CreateTime: 1760000001 }), 1760000001000, 'CreateTime si pas d\'UTC');
    assert.equal(at({ UTC: 0, CreateTime: 1760000002 }), 1760000002000, 'UTC inutilisable : CreateTime');
    // Heure locale a UTC+1 : 11:00:00 locale = 10:00:00 UTC.
    assert.equal(at({ LocaleTime: '2026-10-17 11:00:00' }, { ...CTX, utcOffsetMin: 60 }), Date.UTC(2026, 9, 17, 10, 0, 0));
    assert.equal(at({ LocaleTime: '2026-10-17 10:00:00' }), Date.UTC(2026, 9, 17, 10, 0, 0), 'Abidjan : UTC+0');
    assert.equal(at({}), T0, 'rien : heure de reception');
    for (const bad of [{ UTC: -5 }, { UTC: 'abc' }, { UTC: 1e30 }, { UTC: null }, { UTC: {} }, { LocaleTime: 'hier' }, { LocaleTime: '2026-13-45 99:99:99' }]) assert.equal(at(bad), T0, JSON.stringify(bad));
    // Plus de 24 h dans le futur : reception. +5 min (derive d'horloge) : conservee.
    assert.equal(at({ UTC: Math.floor(T0 / 1000) + 3 * 86400 }), T0);
    assert.equal(at({ UTC: Math.floor(T0 / 1000) + 300 }), T0 + 300_000);
  });

  it('numerotation des portes : doorBase 0 (defaut) ou 1 ; hors plage = rien', () => {
    const t = (data: object, ctx: TranslateContext = CTX, index = 0) => tr(part('AccessControl', 'Pulse', index, { CardNo: '1', UTC: 1700000000, ...data }), ctx);
    assert.equal(passageOf(t({ Door: 0 })).doorNo, 1);
    assert.equal(passageOf(t({ Door: 3 })).doorNo, 4);
    assert.equal(passageOf(t({ Door: 1 }, { ...CTX, doorBase: 1 })).doorNo, 1);
    assert.equal(passageOf(t({}, { ...CTX, doorBase: 1 }, 1)).doorNo, 1, 'sans Door : index + 1 (base 0) ou index (base 1)... ici index 1 -> channel 2 -> base 1 : porte 1');
    for (const d of [4, 7, -1, 1e9, 1.5]) assert.equal(t({ Door: d }).kind, 'none', `Door ${d}`);
    assert.equal(t({ Door: 'x' }).kind, 'none', 'Door illisible : jamais attribue a une autre porte');
    assert.equal(t({ Door: null }).kind, 'passage', 'Door null = absent : index du flux');
    assert.equal(tr(part('AccessControl', 'Pulse', 9, { CardNo: '1' })).kind, 'none', 'index 9 : hors plage');
  });

  it('donnees hostiles : jamais d\'exception, resultat « rien » ou passage borne', () => {
    const huge = 'A'.repeat(2_000_000);
    const nested = `${'['.repeat(100_000)}${']'.repeat(100_000)}`;
    const bodies = [
      part('AccessControl', 'Pulse', 0, 'pas du json'),
      part('AccessControl', 'Pulse', 0, '[1,2,3]'),
      part('AccessControl', 'Pulse', 0, '"texte"'),
      part('AccessControl', 'Pulse', 0, 'null'),
      part('AccessControl', 'Pulse', 0, nested),
      part('AccessControl', 'Pulse', 0, `{"CardNo":"${huge}"}`),
      part('AccessControl', 'Pulse', 0, '{"__proto__":{"polluted":1},"CardNo":"1","constructor":{"prototype":{"x":1}}}'),
      part('AccessControl', 'Pulse', 0, '{"CardNo":{"a":1},"UserID":[1],"CardName":123,"Method":{"x":1},"Status":[],"Door":{},"RecNo":"9e99"}'),
      part('DoorStatus', 'Pulse', 0, 'x'),
      part('BreakIn', 'Start', 0, nested),
      part('ChassisIntruded', 'Start', 0, huge),
      'Code=AccessControl;action=Pulse;index=99999999999999999999;data={}',
      'Code=;action=;index=0',
      'Heartbeat',
      '',
    ];
    for (const b of bodies) {
      let t: Translation | null = null;
      assert.doesNotThrow(() => {
        const ev = parsePart(b);
        t = ev ? translateEvent(ev, CTX) : null;
      }, b.slice(0, 40));
      if (t && (t as Translation).kind === 'passage') {
        const p = passageOf(t);
        assert.ok((p.credential ?? '').length <= 32);
        assert.ok((p.holderName ?? '').length <= 64);
        assert.ok(p.eventId.length >= 1 && p.eventId.length <= 40);
        assert.equal(({} as Record<string, unknown>).polluted, undefined, 'aucune pollution de prototype');
      }
    }
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
  });

  it('nom et badge enormes ou pleins de caracteres de controle : bornes et nettoyes, le message tient sous 1 024 octets', () => {
    const p = passageOf(tr(part('AccessControl', 'Pulse', 0, { CardNo: `00${'9'.repeat(200)}`, CardName: `${'é'.repeat(300)}\u0000\n${RLO}`, UserID: 'u'.repeat(200), UTC: 1700000000, RecNo: 5 })));
    assert.equal(p.credential?.length, 32);
    const msg = passageMessage('CTL-1', p);
    assert.ok(Buffer.byteLength(JSON.stringify(msg)) <= 1024);
    assert.equal(prepare('P-ENTREE', msg, T0).ok, true);
    assert.equal(/\p{Cc}/u.test(msg.access?.holderName ?? '') || (msg.access?.holderName ?? '').includes(RLO), false);
    assert.ok((msg.access?.holderRef ?? '').length <= 32);
  });

  it('evenements de porte : etat, maintenue ouverte (debut / fin), effraction, sabotage du boitier', () => {
    const d = (code: string, action: string, data?: unknown, index = 0) => tr(part(code, action, index, data));
    const door = (t: Translation) => {
      assert.equal(t.kind, 'door', JSON.stringify(t));
      return t as Extract<Translation, { kind: 'door' }>;
    };
    assert.equal(door(d('DoorStatus', 'Pulse', { Status: 'Open' })).doorKind, 'opened');
    assert.equal(door(d('DoorStatus', 'Pulse', { Status: 'Close' })).doorKind, 'closed');
    assert.equal(door(d('DoorStatus', 'Pulse', { Status: ' close ' })).doorKind, 'closed');
    assert.equal(door(d('DoorStatus', 'Pulse', { Status: 'Open', LocaleTime: '2026-10-17 10:00:05' }, 1)).doorNo, 2);
    assert.equal(door(d('DoorStatus', 'Pulse', { Status: 'Open', LocaleTime: '2026-10-17 10:00:05' })).ts, T0 + 5000);
    assert.equal(d('DoorStatus', 'Pulse', { Status: 'Ajar' }).kind, 'none');
    assert.equal(d('DoorStatus', 'Pulse', { Status: 5 }).kind, 'none');
    assert.equal(door(d('DoorNotClosed', 'Start')).doorKind, 'held_open');
    assert.equal(door(d('DoorNotClosed', 'Pulse', {})).doorKind, 'held_open');
    assert.equal(door(d('DoorNotClosed', 'Stop', undefined, 1)).doorKind, 'held_open_end');
    assert.equal(door(d('BreakIn', 'Start')).doorKind, 'forced');
    assert.equal(door(d('BreakIn', 'Pulse')).doorKind, 'forced');
    assert.equal(d('BreakIn', 'Stop').kind, 'none', 'fin d\'effraction : rien (le retour viendra de door_closed)');
    const c = d('ChassisIntruded', 'Start');
    assert.deepEqual([c.kind, (c as { ctlKind?: string }).ctlKind], ['controller', 'tamper']);
    assert.equal((d('ChassisIntruded', 'Stop') as { ctlKind?: string }).ctlKind, 'tamper_end');
    assert.equal(d('Duress', 'Start').kind, 'none');
    assert.match((d('Duress', 'Start') as { reason: string }).reason, /^alarme de contrainte/);
    assert.equal(d('RepeatEnter', 'Pulse').kind, 'none');
    assert.equal(d('VideoMotion', 'Start').kind, 'none');
    assert.equal(d('DoorNotClosed', 'Start', undefined, 7).kind, 'none', 'porte hors plage');
  });

  it('partie du flux : signes de vie et textes inconnus = rien', () => {
    assert.equal(parsePart('Heartbeat'), null);
    assert.equal(parsePart('  '), null);
    assert.equal(parsePart('n\'importe quoi'), null);
    assert.equal(parsePart(undefined as unknown as string), null);
    assert.deepEqual(parsePart('Code=AccessControl;action=Pulse;index=2;data={"a":1}'), { code: 'AccessControl', action: 'Pulse', channel: 3, data: '{"a":1}' });
  });

  it('recordFinder : pages, ordre des indices, champs inconnus et lignes pieges ignores', () => {
    const body = [
      'totalCount=1000',
      'found=3',
      'records[1].RecNo=12346',
      'records[1].CardNo=B',
      'records[0].RecNo=12345',
      'records[0].CardNo=A',
      'records[0].CardName=Zhang San',
      'records[0].Password=NE-JAMAIS',
      'records[0].Inconnu=x',
      'records[999999999].RecNo=1',
      'records[99999].RecNo=2',
      'records[2].RecNo',
      `records[2].CardNo=${'Z'.repeat(5000)}`,
      '=pas de cle',
      'ligne sans egal',
      'records[x].RecNo=3',
      'records[2].RecNo=12347\r',
    ].join('\r\n');
    const page = parseRecordPage(body);
    assert.equal(page.totalCount, 1000);
    assert.equal(page.found, 3);
    assert.deepEqual(page.records.map((r) => r.RecNo), ['12345', '12346', '12347']);
    assert.equal(page.records[0]!.CardName, 'Zhang San');
    assert.equal(JSON.stringify(page).includes('NE-JAMAIS'), false);
    assert.equal(page.records[2]!.CardNo, undefined, 'valeur de plus de 600 caracteres ignoree');
    assert.deepEqual(parseRecordPage(''), { totalCount: null, found: null, records: [] });
    assert.deepEqual(parseRecordPage('\u0000\u0001binaire'), { totalCount: null, found: null, records: [] });
    assert.doesNotThrow(() => parseRecordPage('records[0].RecNo=1\n'.repeat(300_000)));
  });

  it('enregistrement de la memoire -> passage ; sans numero de porte : l\'unique porte declaree', () => {
    const rec = { RecNo: '77', CreateTime: '1760000000', CardNo: '0012345', CardName: 'KONAN Yao', UserID: '101', Type: 'Exit', Method: '1', Status: '0', ErrorCode: '21', Door: '1' };
    const p = passageOf(translateRecord(rec, CTX));
    assert.deepEqual([p.eventId, p.cursor, p.doorNo, p.direction, p.result, p.reason, p.ts], ['77', '77', 2, 'out', 'denied', 'antipassback', 1760000000000]);
    const { Door: _door, ...noDoor } = rec;
    assert.equal(translateRecord(noDoor, { ...CTX, doorNos: [1, 2] }).kind, 'none', 'deux portes : ambigu');
    assert.equal(passageOf(translateRecord(noDoor, { ...CTX, doorNos: [2] })).doorNo, 2);
  });

  it('heure du controleur, etat de porte et mode : formats de reponse', () => {
    assert.equal(parseCurrentTime('result=2026-10-17 10:00:00\r\n', 0), T0);
    assert.equal(parseCurrentTime('result = 2026-1-7 9:05:03', 0), Date.UTC(2026, 0, 7, 9, 5, 3));
    assert.equal(parseCurrentTime('result=2026-10-17 11:00:00', 60), T0, 'heure locale UTC+1');
    for (const bad of ['', 'Error', 'result=hier', 'result=2026-13-40 99:00:00', `result=${'9'.repeat(50)}`]) assert.equal(parseCurrentTime(bad, 0), null, bad);
    assert.equal(parseDoorStatus('Info.status=Open\r\n'), 'open');
    assert.equal(parseDoorStatus('Info.status=Close'), 'closed');
    assert.equal(parseDoorStatus('Info.status=Break'), 'break');
    for (const bad of ['', 'Error', 'Info.status=Mystere', 'status=']) assert.equal(parseDoorStatus(bad), null, bad);
    const cfg = 'table.AccessControl[0].State=Normal\r\ntable.AccessControl[0].UnlockHoldInterval=2500\r\ntable.AccessControl[1].State=OpenAlways\r\n';
    assert.equal(parseDoorMode(cfg, 0), 'Normal');
    assert.equal(parseDoorMode(cfg, 1), 'OpenAlways');
    assert.equal(parseDoorMode(cfg, 2), null);
    assert.equal(parseDoorMode('Error', 0), null);
  });

  it('proprieteS : tout ce que le traducteur produit est accepte par le code commun et par prepare(), ou ignore', () => {
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const pick = <T,>(list: T[]): T => list[Math.floor(rnd() * list.length)]!;
    const junk: unknown[] = [0, 1, 2, 5, 15, -1, 1e15, 1.5, 'a', '', 'Entry', 'Exit', null, true, {}, [], 'x'.repeat(300), '\u0000', RLO, 'é', '0x15', '12EA3004', 1760000000, 1760000000.5];
    for (let i = 0; i < 400; i++) {
      const data: Record<string, unknown> = {};
      for (const k of ['CardNo', 'CardName', 'UserID', 'Method', 'Status', 'Type', 'Door', 'ErrorCode', 'UTC', 'CreateTime', 'RecNo', 'LocaleTime', 'Password']) if (rnd() < 0.7) data[k] = pick(junk);
      const box: { got: Translation | null } = { got: null };
      assert.doesNotThrow(() => {
        const ev = parsePart(part('AccessControl', pick(['Pulse', 'Start', 'Stop', '']), Math.floor(rnd() * 6), data));
        box.got = ev ? translateEvent(ev, CTX) : null;
      });
      const got = box.got;
      if (got?.kind === 'passage') {
        const msg = passageMessage('CTL-1', got.passage);
        const r = prepare('P-ENTREE', msg, T0);
        assert.equal(r.ok, true, JSON.stringify(data) + ' -> ' + (r.ok ? '' : r.error));
        assert.equal(JSON.stringify(msg).includes('Password'), false);
      }
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------------------------------------------------------

const baseController = () => ({
  id: 'CTL-1',
  host: '192.168.10.20',
  port: 80,
  username: 'psim',
  password: 'secret-Tres-Long-1',
  utcOffsetMin: 0,
  doors: { '1': 'P-ENTREE', '2': 'P-SALLE-SERVEUR' },
  actuators: { 'ACT-ENTREE': { door: 1, type: 'lock' }, 'ACT-BARRIERE': { door: 2, type: 'gate' } },
});

function errorsOf(config: Record<string, unknown>): string[] {
  try {
    parseConfig(config);
  } catch (err) {
    return (err as Error).message.split('\n').slice(1).map((l) => l.replace(/^\s*-\s*/, ''));
  }
  return [];
}

describe('acces-dahua : configuration', () => {
  it('configuration complete valide, valeurs par defaut', () => {
    const cfg = parseConfig({ controllers: [baseController()] });
    assert.equal(cfg.stateDir, null);
    assert.deepEqual(cfg.thresholds, DEFAULT_THRESHOLDS);
    assert.deepEqual(cfg.reconnect, { minMs: 1000, maxMs: 60_000 });
    const c = cfg.controllers[0]!;
    assert.deepEqual([c.id, c.host, c.port, c.username, c.utcOffsetMin, c.doorBase, c.remoteUserId], ['CTL-1', '192.168.10.20', 80, 'psim', 0, 0, null]);
    assert.deepEqual([...c.doors], [[1, 'P-ENTREE'], [2, 'P-SALLE-SERVEUR']]);
    assert.deepEqual([...c.actuators], [['ACT-ENTREE', { door: 1, type: 'lock' }], ['ACT-BARRIERE', { door: 2, type: 'gate' }]]);
  });

  it('exemple complet de la documentation', () => {
    const cfg = parseConfig({
      stateDir: 'data/acces',
      controllers: [{ ...baseController(), port: 8080, utcOffsetMin: 60, doorBase: 1, remoteUserId: 9, host: 'controleur-1.local' }],
      thresholds: { deniedCount: 5, deniedWindowS: 120, heartbeatS: 30, clockDriftMs: 60_000, silenceMs: 20_000, offlineGraceMs: 10_000, longUnlockS: 90 },
      reconnect: { minMs: 500, maxMs: 30_000 },
    });
    assert.equal(cfg.stateDir, 'data/acces');
    assert.deepEqual(cfg.thresholds, { deniedCount: 5, deniedWindowS: 120, heartbeatS: 30, clockDriftMs: 60_000, silenceMs: 20_000, offlineGraceMs: 10_000, longUnlockS: 90 });
    assert.equal(cfg.controllers[0]!.doorBase, 1);
  });

  const bad: [string, (c: Record<string, unknown>) => Record<string, unknown>, RegExp][] = [
    ['cle inconnue au sommet', (c) => ({ ...c, extra: 1 }), /cle inconnue « extra »/],
    ['controleurs absents', () => ({}), /controllers : la liste doit contenir au moins un controleur/],
    ['liste vide', () => ({ controllers: [] }), /au moins un controleur/],
    ['plus de 16 controleurs', () => ({ controllers: Array.from({ length: 17 }, (_, i) => ({ ...baseController(), id: `C${i}`, doors: { '1': `D${i}` }, actuators: {} })) }), /au plus 16/],
    ['controleur pas un objet', () => ({ controllers: ['x'] }), /un objet est attendu/],
    ['cle inconnue du controleur', (c) => ({ controllers: [{ ...baseController(), proxy: 'x' }] }), /cle inconnue « proxy »/],
    ['id manquant', () => ({ controllers: [{ ...baseController(), id: undefined }] }), /« id » est obligatoire/],
    ['id invalide', () => ({ controllers: [{ ...baseController(), id: 'CTL 1' }] }), /« id » est obligatoire/],
    ['id trop long', () => ({ controllers: [{ ...baseController(), id: 'C'.repeat(33) }] }), /« id » est obligatoire/],
    ['hote avec schema', () => ({ controllers: [{ ...baseController(), host: 'http://192.168.1.2' }] }), /« host » est obligatoire/],
    ['hote avec chemin', () => ({ controllers: [{ ...baseController(), host: '192.168.1.2/x' }] }), /« host »/],
    ['hote vide', () => ({ controllers: [{ ...baseController(), host: '' }] }), /« host »/],
    ['port 0', () => ({ controllers: [{ ...baseController(), port: 0 }] }), /« port »/],
    ['port 70000', () => ({ controllers: [{ ...baseController(), port: 70000 }] }), /« port »/],
    ['port texte', () => ({ controllers: [{ ...baseController(), port: '80' }] }), /« port »/],
    ['nom d\'utilisateur avec guillemet', () => ({ controllers: [{ ...baseController(), username: 'ps"im' }] }), /« username »/],
    ['nom d\'utilisateur accentue', () => ({ controllers: [{ ...baseController(), username: 'psimé' }] }), /« username »/],
    ['mot de passe vide', () => ({ controllers: [{ ...baseController(), password: '' }] }), /« password » est obligatoire/],
    ['mot de passe non texte', () => ({ controllers: [{ ...baseController(), password: { $file: 'x' } }] }), /« password » est obligatoire/],
    ['mot de passe trop long', () => ({ controllers: [{ ...baseController(), password: 'x'.repeat(129) }] }), /« password »/],
    ['decalage horaire hors plage', () => ({ controllers: [{ ...baseController(), utcOffsetMin: 900 }] }), /utcOffsetMin/],
    ['decalage horaire fractionnaire', () => ({ controllers: [{ ...baseController(), utcOffsetMin: 1.5 }] }), /utcOffsetMin/],
    ['doorBase invalide', () => ({ controllers: [{ ...baseController(), doorBase: 2 }] }), /doorBase/],
    ['remoteUserId negatif', () => ({ controllers: [{ ...baseController(), remoteUserId: -1 }] }), /remoteUserId/],
    ['portes absentes', () => ({ controllers: [{ ...baseController(), doors: undefined }] }), /« doors » est obligatoire/],
    ['portes vides', () => ({ controllers: [{ ...baseController(), doors: {} }] }), /« doors » est obligatoire/],
    ['porte 0', () => ({ controllers: [{ ...baseController(), doors: { '0': 'P', '1': 'Q' }, actuators: {} }] }), /numero de porte « 0 »/],
    ['porte 5', () => ({ controllers: [{ ...baseController(), doors: { '5': 'P' }, actuators: {} }] }), /numero de porte « 5 »/],
    ['porte « un »', () => ({ controllers: [{ ...baseController(), doors: { un: 'P' }, actuators: {} }] }), /numero de porte « un »/],
    ['identifiant de detecteur invalide', () => ({ controllers: [{ ...baseController(), doors: { '1': 'P ENTREE' }, actuators: {} }] }), /« doors.1 »/],
    ['detecteur utilise deux fois (meme controleur)', () => ({ controllers: [{ ...baseController(), doors: { '1': 'P', '2': 'P' }, actuators: {} }] }), /« P » est deja utilise/],
    ['detecteur utilise par deux controleurs', () => ({ controllers: [baseController(), { ...baseController(), id: 'CTL-2', actuators: {} }] }), /deja utilise/],
    ['controleur en double', () => ({ controllers: [baseController(), { ...baseController(), doors: { '1': 'Z1' }, actuators: {} }] }), /« CTL-1 » est deja utilise/],
    ['actionneur sur une porte non declaree', () => ({ controllers: [{ ...baseController(), actuators: { A: { door: 3, type: 'lock' } } }] }), /« actuators.A.door » doit etre une porte declaree/],
    ['type d\'actionneur invalide', () => ({ controllers: [{ ...baseController(), actuators: { A: { door: 1, type: 'relay' } } }] }), /« actuators.A.type »/],
    ['actionneur avec cle inconnue', () => ({ controllers: [{ ...baseController(), actuators: { A: { door: 1, type: 'lock', zone: 1 } } }] }), /cle inconnue « zone »/],
    ['id d\'actionneur invalide', () => ({ controllers: [{ ...baseController(), actuators: { 'A B': { door: 1, type: 'lock' } } }] }), /« actuators » : identifiant/],
    ['actionneur declare par deux controleurs', () => ({ controllers: [baseController(), { ...baseController(), id: 'CTL-2', doors: { '1': 'Q1' } }] }), /« ACT-ENTREE » est deja declare/],
    ['actionneurs pas un objet', () => ({ controllers: [{ ...baseController(), actuators: [] }] }), /« actuators » doit etre un objet/],
    ['seuil inconnu', () => ({ controllers: [baseController()], thresholds: { vitesse: 1 } }), /cle inconnue « vitesse »/],
    ['seuil hors bornes', () => ({ controllers: [baseController()], thresholds: { deniedCount: 0 } }), /thresholds.deniedCount/],
    ['seuil non entier', () => ({ controllers: [baseController()], thresholds: { silenceMs: 1000.5 } }), /thresholds.silenceMs/],
    ['seuil texte', () => ({ controllers: [baseController()], thresholds: { heartbeatS: '60' } }), /thresholds.heartbeatS/],
    ['seuils pas un objet', () => ({ controllers: [baseController()], thresholds: 5 }), /thresholds : un objet/],
    ['reconnexion max < min', () => ({ controllers: [baseController()], reconnect: { minMs: 5000, maxMs: 1000 } }), /maxMs \(1000\) doit etre superieur/],
    ['reconnexion cle inconnue', () => ({ controllers: [baseController()], reconnect: { fois: 3 } }), /cle inconnue « fois »/],
    ['reconnexion min trop petit', () => ({ controllers: [baseController()], reconnect: { minMs: 1 } }), /reconnect.minMs/],
    ['stateDir vide', () => ({ controllers: [baseController()], stateDir: '  ' }), /stateDir/],
    ['stateDir non texte', () => ({ controllers: [baseController()], stateDir: 5 }), /stateDir/],
  ];
  for (const [name, make, re] of bad) {
    it(`refuse : ${name}`, () => {
      const errs = errorsOf(make({ controllers: [baseController()] }));
      assert.ok(errs.length > 0, 'devait etre refuse');
      assert.ok(errs.some((e) => re.test(e)), errs.join(' | '));
    });
  }

  it('toutes les erreurs d\'un coup, et le mot de passe n\'apparait jamais dans un message', () => {
    const errs = errorsOf({
      extra: 1,
      thresholds: { deniedCount: 0 },
      controllers: [{ ...baseController(), id: 'a b', host: 'http://x', port: 0, password: '' }, { ...baseController(), doors: { '9': 'P' } }],
    });
    assert.ok(errs.length >= 6, errs.join('\n'));
    const secret = 'MotDePasse-Tres-Secret-9';
    const withSecret = errorsOf({ controllers: [{ ...baseController(), password: secret, port: 0, host: `bad host ${secret}`, username: `u"${secret}` }] });
    assert.ok(withSecret.length >= 2);
    assert.equal(withSecret.join('\n').includes(secret), false);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// Requetes HTTP Digest
// ---------------------------------------------------------------------------------------------------------------------------

function clockOf(start = T0) {
  const clock = { t: start };
  return { clock, now: () => clock.t };
}

async function startFake(opts: FakeDahuaOptions = {}): Promise<FakeDahua> {
  const fake = await FakeDahua.start({ heartbeatMs: 40, ...opts });
  cleanup.push(() => fake.close());
  return fake;
}

describe('acces-dahua : requetes HTTP Digest', () => {
  it('un defi 401 puis la reponse authentifiee ; corps rendu', async () => {
    const fake = await startFake();
    const { now } = clockOf();
    const http = new DahuaHttp({ host: fake.host, port: fake.port, username: fake.username, password: fake.password }, { gate: new AuthGate(now) });
    const res = await http.get('/cgi-bin/global.cgi?action=getCurrentTime');
    assert.equal(res.status, 200);
    assert.match(res.body, /^result=\d{4}-/);
    assert.equal(fake.challenges, 1);
    assert.equal(fake.authOk, 1);
    assert.deepEqual(fake.requests.map((r) => r.path), ['/cgi-bin/global.cgi?action=getCurrentTime']);
  });

  it('un code HTTP different de 200 est rendu, pas leve', async () => {
    const fake = await startFake();
    const http = new DahuaHttp({ host: fake.host, port: fake.port, username: fake.username, password: fake.password }, { gate: new AuthGate(() => T0) });
    const res = await http.get('/cgi-bin/inconnu.cgi');
    assert.equal(res.status, 404);
  });

  it('identifiants refuses : DahuaAuthError, puis AUCUNE requete pendant 5 minutes, puis de nouveau permis', async () => {
    const fake = await startFake();
    const { clock, now } = clockOf();
    const gate = new AuthGate(now);
    const http = new DahuaHttp({ host: fake.host, port: fake.port, username: fake.username, password: 'mauvais-mot-de-passe' }, { gate });
    await assert.rejects(http.get('/cgi-bin/global.cgi?action=getCurrentTime'), DahuaAuthError);
    const before = fake.connections;
    const requestsBefore = fake.challenges;
    for (let i = 0; i < 5; i++) await assert.rejects(http.get('/cgi-bin/global.cgi?action=getCurrentTime'), DahuaAuthError);
    assert.equal(fake.challenges, requestsBefore, 'aucun nouvel essai');
    assert.equal(fake.connections, before, 'aucune nouvelle connexion');
    clock.t += AUTH_BLOCK_MS - 1;
    await assert.rejects(http.get('/x'), DahuaAuthError);
    assert.equal(fake.challenges, requestsBefore);
    clock.t += 2;
    const good = new DahuaHttp({ host: fake.host, port: fake.port, username: fake.username, password: fake.password }, { gate });
    assert.equal((await good.get('/cgi-bin/global.cgi?action=getCurrentTime')).status, 200, 'la barriere est levee apres 5 minutes');
    assert.equal(gate.blocked(), false);
  });

  it('horloge revenue en arriere : l\'attente ne depasse jamais 5 minutes', () => {
    const { clock, now } = clockOf();
    const gate = new AuthGate(now);
    gate.block();
    clock.t -= 3_600_000;
    assert.ok(gate.remainingMs() <= AUTH_BLOCK_MS);
  });

  it('nom d\'utilisateur impossible en Digest : refus sans requete inutile', async () => {
    const fake = await startFake();
    const http = new DahuaHttp({ host: fake.host, port: fake.port, username: 'ps"im', password: 'x' }, { gate: new AuthGate(() => T0) });
    await assert.rejects(http.get('/x'), DahuaAuthError);
  });

  it('Basic refuse : le mot de passe ne part jamais en clair', async () => {
    const seen: (string | undefined)[] = [];
    const server = createServer((req, res) => {
      seen.push(req.headers.authorization);
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="x"' });
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    cleanup.push(() => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))));
    const http = new DahuaHttp({ host: '127.0.0.1', port: (server.address() as AddressInfo).port, username: 'psim', password: 'mdp-secret' }, { gate: new AuthGate(() => T0) });
    await assert.rejects(http.get('/x'), DahuaAuthError);
    assert.deepEqual(seen, [undefined], 'une seule requete, sans Authorization');
  });

  it('reponse trop grande (au-dela de la borne) : interrompue', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      const chunk = Buffer.alloc(64 * 1024, 65);
      let n = 0;
      const send = () => {
        while (n++ < 64) if (!res.write(chunk)) return void res.once('drain', send);
        res.end();
      };
      send();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    cleanup.push(() => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))));
    const http = new DahuaHttp({ host: '127.0.0.1', port: (server.address() as AddressInfo).port, username: 'psim', password: 'x' }, { gate: new AuthGate(() => T0), maxBytes: 1024 * 1024 });
    await assert.rejects(http.get('/gros'), (err: unknown) => err instanceof DahuaHttpError && err.code === 'too_large');
  });

  it('delai depasse : code timeout ; controleur absent : unreachable ; messages sans adresse ni mot de passe', async () => {
    const fake = await startFake();
    fake.behavior.openDoor = 'hang';
    const http = new DahuaHttp({ host: fake.host, port: fake.port, username: fake.username, password: fake.password }, { gate: new AuthGate(() => T0), timeoutMs: 150 });
    const started = Date.now();
    await assert.rejects(http.get('/cgi-bin/accessControl.cgi?action=openDoor&channel=1'), (err: unknown) => {
      assert.ok(err instanceof DahuaHttpError);
      assert.equal(err.code, 'timeout');
      assert.equal(err.message.includes(fake.password) || err.message.includes('127.0.0.1'), false);
      return true;
    });
    assert.ok(Date.now() - started < 3000);
    const port = fake.port;
    await fake.close();
    const closed = new DahuaHttp({ host: '127.0.0.1', port, username: 'psim', password: 'Secret-Absolu-1' }, { gate: new AuthGate(() => T0) });
    await assert.rejects(closed.get('/x'), (err: unknown) => {
      assert.ok(err instanceof DahuaHttpError);
      assert.equal(err.code, 'unreachable');
      assert.equal(/Secret-Absolu|127\.0\.0\.1|\d{4,5}/.test(err.message), false, err.message);
      return true;
    });
  });

  it('stop() annule la requete en cours et refuse les suivantes', async () => {
    const fake = await startFake();
    fake.behavior.openDoor = 'hang';
    const http = new DahuaHttp({ host: fake.host, port: fake.port, username: fake.username, password: fake.password }, { gate: new AuthGate(() => T0), timeoutMs: 30_000 });
    const pending = http.get('/cgi-bin/accessControl.cgi?action=openDoor&channel=1');
    await sleep(100);
    http.stop();
    await assert.rejects(pending, (err: unknown) => err instanceof DahuaHttpError && err.code === 'stopped');
    await assert.rejects(http.get('/x'), (err: unknown) => err instanceof DahuaHttpError && err.code === 'stopped');
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// Pilote de porte (gestionnaire d'actionneur)
// ---------------------------------------------------------------------------------------------------------------------------

function driverFor(fake: FakeDahua, opts: { remoteUserId?: number; timeoutMs?: number } = {}) {
  const http = new DahuaHttp({ host: fake.host, port: fake.port, username: fake.username, password: fake.password }, { gate: new AuthGate(() => T0), timeoutMs: opts.timeoutMs });
  cleanup.push(() => http.stop());
  return { http, driver: new DahuaDoorDriver(http, { remoteUserId: opts.remoteUserId }) };
}

const req = (action: string, durationS?: number) => ({ actuatorId: 'A', cmdId: 'c', action, ...(durationS === undefined ? {} : { durationS }) });

describe('acces-dahua : pilote de porte', () => {
  it('impulsion : openDoor sur le canal = numero de porte, Type=Remote, sans UserID par defaut', async () => {
    const fake = await startFake();
    const { driver } = driverFor(fake);
    const h = makeActuatorHandler({ kind: 'lock', doorNo: 2 }, driver);
    assert.deepEqual(await h(req('unlock')), { result: 'done' });
    assert.equal(fake.commands.length, 1);
    assert.deepEqual(fake.commands[0], { action: 'openDoor', channel: 2, query: { action: 'openDoor', channel: '2', Type: 'Remote' } });
    assert.deepEqual(fake.configWrites, [], 'une impulsion ne touche pas a la configuration');
  });

  it('impulsion avec remoteUserId configure', async () => {
    const fake = await startFake();
    const { driver } = driverFor(fake, { remoteUserId: 101 });
    await makeActuatorHandler({ kind: 'lock', doorNo: 1 }, driver)(req('unlock', 5));
    assert.equal(fake.commands[0]!.query.UserID, '101');
  });

  it('ouverture prolongee : mode OpenAlways de la porte visee SEULEMENT, le reste de la configuration est intact', async () => {
    const fake = await startFake();
    const before = JSON.stringify(fake.otherConfig);
    const { driver } = driverFor(fake);
    const h = makeActuatorHandler({ kind: 'lock', doorNo: 2 }, driver);
    assert.deepEqual(await h(req('unlock', 600)), { result: 'done' });
    assert.deepEqual(fake.modes, ['Normal', 'OpenAlways', 'Normal', 'Normal']);
    assert.deepEqual(fake.configWrites, [{ 'AccessControl[1].State': 'OpenAlways' }], 'une seule cle ecrite');
    assert.equal(JSON.stringify(fake.otherConfig), before);
    assert.deepEqual(fake.commands, [], 'pas d\'impulsion en plus');
    // Deja dans ce mode : rien n'est reecrit.
    await h(req('unlock', 600));
    assert.equal(fake.configWrites.length, 1);
    // La lecture precede l'ecriture.
    const paths = fake.requests.map((r) => r.path);
    assert.ok(paths.findIndex((p) => p.includes('getConfig')) < paths.findIndex((p) => p.includes('setConfig')));
  });

  it('lock : mode Normal PUIS closeDoor, jamais CloseAlways', async () => {
    const fake = await startFake();
    fake.modes[0] = 'OpenAlways';
    const { driver } = driverFor(fake);
    const h = makeActuatorHandler({ kind: 'lock', doorNo: 1 }, driver);
    assert.deepEqual(await h(req('lock')), { result: 'done' });
    assert.equal(fake.modes[0], 'Normal');
    const order = fake.requests.map((r) => r.path.replace(/^.*action=/, '').split('&')[0]);
    assert.deepEqual(order, ['getConfig', 'setConfig', 'closeDoor']);
    assert.ok(fake.configWrites.every((w) => Object.values(w).every((v) => v !== 'CloseAlways')));
    // Mode deja normal : seulement la fermeture.
    fake.requests.length = 0;
    fake.configWrites.length = 0;
    await h(req('lock'));
    assert.deepEqual(fake.requests.map((r) => r.path.replace(/^.*action=/, '').split('&')[0]), ['getConfig', 'closeDoor']);
    assert.deepEqual(fake.configWrites, []);
    assert.equal(fake.modes.includes('CloseAlways'), false);
  });

  it('barriere (gate) : open, open long, close ; stop refuse (not_supported)', async () => {
    const fake = await startFake();
    const { driver } = driverFor(fake);
    const h = makeActuatorHandler({ kind: 'gate', doorNo: 1 }, driver);
    assert.deepEqual(await h(req('open')), { result: 'done' });
    assert.deepEqual(await h(req('open', 300)), { result: 'done' });
    assert.deepEqual(await h(req('close')), { result: 'done' });
    assert.deepEqual(await h(req('stop')), { result: 'refused', code: 'not_supported' });
    assert.equal((driver as { stop?: unknown }).stop, undefined);
  });

  it('controleur injoignable : error / unreachable', async () => {
    const fake = await startFake();
    const { driver } = driverFor(fake);
    await fake.close();
    const logs: string[] = [];
    const h = makeActuatorHandler({ kind: 'lock', doorNo: 1 }, driver, { log: (_l, t) => void logs.push(t) });
    assert.deepEqual(await h(req('unlock')), { result: 'error', code: 'unreachable' });
    assert.deepEqual(await h(req('lock')), { result: 'error', code: 'unreachable' });
    assert.deepEqual(await h(req('unlock', 600)), { result: 'error', code: 'unreachable' });
    assert.ok(logs.every((t) => !/127\.0\.0\.1|mot de passe/i.test(t)));
  });

  it('delai depasse : error / timeout', async () => {
    const fake = await startFake();
    fake.behavior.openDoor = 'hang';
    const { driver } = driverFor(fake, { timeoutMs: 150 });
    assert.deepEqual(await makeActuatorHandler({ kind: 'lock', doorNo: 1 }, driver)(req('unlock')), { result: 'error', code: 'timeout' });
  });

  it('refus du materiel : reponse « Error », corps vide, HTTP 500, ecriture refusee : error / refused_by_device', async () => {
    const fake = await startFake();
    const { driver } = driverFor(fake);
    const h = makeActuatorHandler({ kind: 'lock', doorNo: 1 }, driver);
    for (const b of ['error', 'empty', 'http500'] as const) {
      fake.behavior.openDoor = b;
      assert.deepEqual(await h(req('unlock')), { result: 'error', code: 'refused_by_device' }, b);
    }
    fake.behavior.openDoor = 'ok';
    fake.behavior.setConfig = 'error';
    assert.deepEqual(await h(req('unlock', 600)), { result: 'error', code: 'refused_by_device' });
    assert.equal(fake.modes[0], 'Normal', 'rien n\'a change');
    fake.behavior.setConfig = 'ok';
    fake.behavior.closeDoor = 'error';
    fake.modes[0] = 'OpenAlways';
    assert.deepEqual(await h(req('lock')), { result: 'error', code: 'refused_by_device' });
    assert.equal(fake.modes[0], 'Normal', 'le mode normal est rendu meme si la fermeture echoue : etat sur');
  });

  it('identifiants refuses par le controleur : error / refused_by_device', async () => {
    const fake = await startFake();
    const http = new DahuaHttp({ host: fake.host, port: fake.port, username: fake.username, password: 'faux-mot-de-passe' }, { gate: new AuthGate(() => T0) });
    cleanup.push(() => http.stop());
    const h = makeActuatorHandler({ kind: 'lock', doorNo: 1 }, new DahuaDoorDriver(http));
    assert.deepEqual(await h(req('unlock')), { result: 'error', code: 'refused_by_device' });
  });

  it('mode de la porte introuvable dans la configuration : refuse, rien n\'est ecrit', async () => {
    const fake = await startFake({ doors: 1 });
    const { driver } = driverFor(fake);
    const h = makeActuatorHandler({ kind: 'lock', doorNo: 2 }, driver);
    assert.deepEqual(await h(req('unlock', 600)), { result: 'error', code: 'refused_by_device' });
    assert.deepEqual(fake.configWrites, []);
  });

  it('ordres simultanes sur une meme porte : serialises (jamais entrelaces) ; deux portes en parallele', async () => {
    const fake = await startFake();
    fake.latencyMs = 30;
    const { driver } = driverFor(fake);
    const h1 = makeActuatorHandler({ kind: 'lock', doorNo: 1 }, driver);
    const results = await Promise.all([h1(req('unlock', 600)), h1(req('lock')), h1(req('unlock')), h1(req('unlock', 600))]);
    assert.deepEqual(results, Array(4).fill({ result: 'done' }));
    const seq = fake.requests.map((r) => r.path.replace(/^.*action=/, '').split('&')[0]);
    // 1. holdOpen: getConfig,setConfig  2. lock: getConfig,setConfig,closeDoor  3. pulse: openDoor  4. holdOpen: getConfig,setConfig
    assert.deepEqual(seq, ['getConfig', 'setConfig', 'getConfig', 'setConfig', 'closeDoor', 'openDoor', 'getConfig', 'setConfig']);
    assert.equal(fake.modes[0], 'OpenAlways');
  });

  it('un ordre en echec ne bloque pas le suivant', async () => {
    const fake = await startFake();
    const { driver } = driverFor(fake);
    const h = makeActuatorHandler({ kind: 'lock', doorNo: 1 }, driver);
    fake.behavior.openDoor = 'error';
    const first = h(req('unlock'));
    await waitFor(() => fake.commands.length === 1, 3000, 'premier ordre recu');
    fake.behavior.openDoor = 'ok';
    const second = h(req('unlock'));
    assert.equal((await first).result, 'error');
    assert.equal((await second).result, 'done');
  });

  it('numero de porte invalide : refuse sans requete', async () => {
    const fake = await startFake();
    const { driver } = driverFor(fake);
    for (const n of [0, -1, 1.5, NaN, 65]) {
      assert.deepEqual(await makeActuatorHandler({ kind: 'lock', doorNo: n }, driver)(req('unlock')), { result: 'error', code: 'refused_by_device' });
    }
    assert.equal(fake.requests.length, 0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// Module complet contre le faux controleur
// ---------------------------------------------------------------------------------------------------------------------------

interface Sent {
  deviceId: string;
  msg: DeviceMessage;
}

interface Harness {
  fake: FakeDahua;
  mod: AccesDahuaModule;
  sent: Sent[];
  logs: string[];
  clock: { t: number };
  actuators: Map<string, ActuatorHandler>;
  refuse: { on: boolean };
  stateDir: string;
  /** Saute l'horloge puis laisse arriver un signe de vie du flux avant de faire tourner la surveillance. */
  advance(ms: number, opts?: { settle?: boolean }): Promise<void>;
  events(deviceId?: string): string[];
  of(event: string, deviceId?: string): Sent[];
  stop(): Promise<void>;
}

interface BootOptions {
  fake?: FakeDahua;
  fakeOpts?: FakeDahuaOptions;
  config?: Record<string, unknown>;
  controller?: Record<string, unknown>;
  thresholds?: Record<string, unknown>;
  reconnect?: { minMs: number; maxMs: number };
  internals?: Parameters<typeof createModule>[1];
  stateDir?: string;
  clock?: { t: number };
  noStart?: boolean;
}

function configFor(fake: FakeDahua, stateDir: string, o: BootOptions = {}): Record<string, unknown> {
  return {
    stateDir,
    controllers: [
      {
        id: 'CTL-1',
        host: fake.host,
        port: fake.port,
        username: fake.username,
        password: fake.password,
        doors: { '1': 'P-ENTREE', '2': 'P-SALLE' },
        actuators: { 'ACT-ENTREE': { door: 1, type: 'lock' }, 'ACT-BARRIERE': { door: 2, type: 'gate' } },
        ...o.controller,
      },
    ],
    thresholds: { silenceMs: 30_000, offlineGraceMs: 15_000, ...o.thresholds },
    reconnect: o.reconnect ?? { minMs: 50, maxMs: 400 },
    ...o.config,
  };
}

async function boot(o: BootOptions = {}): Promise<Harness> {
  const clock = o.clock ?? { t: T0 };
  const fake = o.fake ?? (await startFake({ now: () => clock.t, ...o.fakeOpts }));
  const stateDir = o.stateDir ?? tempDir(cleanup);
  const sent: Sent[] = [];
  const logs: string[] = [];
  const actuators = new Map<string, ActuatorHandler>();
  const refuse = { on: false };
  const ctx = {
    emit: (deviceId: string, msg: DeviceMessage) => {
      if (refuse.on) return false;
      sent.push({ deviceId, msg });
      return true;
    },
    openMqtt: async () => {
      throw new Error('non utilise');
    },
    log: (level: string, text: string) => {
      logs.push(`${level} ${text}`);
      allLogs.push(text);
    },
    config: {},
    now: () => clock.t,
    onActuator: (id: string, h: ActuatorHandler) => void actuators.set(id, h),
  } as unknown as ModuleContext;
  const mod = createModule(configFor(fake, stateDir, o), { tickMs: null, ...o.internals });
  const h: Harness = {
    fake,
    mod,
    sent,
    logs,
    clock,
    actuators,
    refuse,
    stateDir,
    async advance(ms, opts) {
      clock.t += ms;
      if (opts?.settle !== false) await sleep(150);
      mod.tick();
    },
    events: (deviceId) => sent.filter((s) => deviceId === undefined || s.deviceId === deviceId).map((s) => s.msg.event ?? `state:${s.msg.state}`),
    of: (event, deviceId) => sent.filter((s) => (s.msg.event === event || (event.startsWith('state:') && s.msg.state === event.slice(6))) && (deviceId === undefined || s.deviceId === deviceId)),
    stop: () => mod.stop(),
  };
  cleanup.push(() => mod.stop());
  if (!o.noStart) await mod.start(ctx);
  (h as unknown as { ctx: ModuleContext }).ctx = ctx;
  return h;
}

/** Attend que le controleur soit en ligne (premier signe de vie du flux recu et traite). */
async function online(h: Harness, ctl = 0): Promise<void> {
  await waitFor(() => h.mod.all[ctl]!.supervisor.state().online, 8000, 'controleur en ligne');
}

/** Attend que le travail de fond (heure, recuperation, etat des portes) soit termine. */
async function settled(h: Harness): Promise<void> {
  await waitFor(() => {
    h.mod.tick();
    const c = h.mod.all[0]!.state();
    return c.phase === 'connected' && h.fake.recordFinds > 0 && !c.gap && !h.mod.all[0]!.busy();
  }, 8000, 'recuperation terminee');
}

const accessMsgs = (h: Harness) => h.sent.filter((s) => s.msg.access !== undefined);

describe('acces-dahua : module contre un faux controleur', () => {
  it('connexion Digest, signe de vie immediat pour chaque porte, heure lue, aucun message inutile', async () => {
    const h = await boot();
    await online(h);
    await settled(h);
    assert.equal(h.fake.openStreams, 1);
    assert.equal(h.fake.attaches, 1);
    assert.ok(h.fake.authOk >= 1);
    assert.deepEqual(h.events('P-ENTREE').filter((e) => e === 'heartbeat').length, 1);
    assert.deepEqual(h.events('P-SALLE').filter((e) => e === 'heartbeat').length, 1);
    assert.equal(h.fake.requests.some((r) => r.path.includes('getCurrentTime')), true, 'heure lue a la connexion');
    assert.equal(h.fake.requests.some((r) => r.path.includes('recordFinder')), true, 'memoire relue a la connexion');
    // Premier demarrage, memoire vide : aucun passage.
    assert.equal(accessMsgs(h).length, 0);
    // Signe de vie toutes les 60 s.
    await h.advance(61_000);
    assert.equal(h.events('P-ENTREE').filter((e) => e === 'heartbeat').length, 2);
  });

  it('passage accepte : message exactement conforme au contrat, accepte par prepare()', async () => {
    const h = await boot();
    await online(h);
    await settled(h);
    const utc = Math.floor(T0 / 1000);
    h.fake.emitAccess({ recNo: 123456, cardNo: '0012345', cardName: 'KONAN Yao', userId: '101', method: 1, type: 'Entry', door: 0, utc });
    await waitFor(() => accessMsgs(h).length === 1, 5000, 'passage recu');
    const { deviceId, msg } = accessMsgs(h)[0]!;
    assert.equal(deviceId, 'P-ENTREE');
    assert.deepEqual(msg, {
      event: 'badge_granted',
      ts: utc * 1000,
      msgId: 'acc:CTL-1:123456',
      access: { v: 1, controllerId: 'CTL-1', eventId: '123456', direction: 'in', credential: '0012345', holderName: 'KONAN Yao', holderRef: '101', method: 'badge', result: 'granted', reason: null, deferred: false },
    });
    const prepared = prepare(deviceId, msg, h.clock.t);
    assert.equal(prepared.ok, true);
    // Porte 2, sortie, refus : motif.
    h.fake.emitAccess({ recNo: 123457, door: 1, type: 'Exit', status: 0, errorCode: 0x14, cardNo: '0099999', cardName: '', userId: '' });
    await waitFor(() => accessMsgs(h).length === 2, 5000, 'refus recu');
    const second = accessMsgs(h)[1]!;
    assert.equal(second.deviceId, 'P-SALLE');
    assert.equal(second.msg.event, 'badge_denied');
    assert.deepEqual(second.msg.access, { v: 1, controllerId: 'CTL-1', eventId: '123457', direction: 'out', credential: '0099999', holderName: null, holderRef: null, method: 'badge', result: 'denied', reason: 'expired', deferred: false });
    assert.equal(prepare(second.deviceId, second.msg, h.clock.t).ok, true);
  });

  it('un refus isole n\'est pas une alarme ; 3 refus en 60 s sur la meme porte => badge_denied_repeated (une fois)', async () => {
    const h = await boot();
    await online(h);
    await settled(h);
    const utc = Math.floor(T0 / 1000);
    h.fake.emitAccess({ status: 0, errorCode: 0x10, utc, door: 0 });
    await waitFor(() => h.of('badge_denied').length === 1, 5000, 'premier refus');
    assert.equal(h.of('badge_denied_repeated').length, 0);
    h.fake.emitAccess({ status: 0, errorCode: 0x10, utc: utc + 20, door: 0 });
    h.fake.emitAccess({ status: 0, errorCode: 0x10, utc: utc + 40, door: 1 }); // autre porte : ne compte pas
    await waitFor(() => h.of('badge_denied').length === 3, 5000, 'refus');
    assert.equal(h.of('badge_denied_repeated').length, 0);
    h.fake.emitAccess({ status: 0, errorCode: 0x10, utc: utc + 50, door: 0 });
    await waitFor(() => h.of('badge_denied_repeated').length === 1, 5000, 'refus repetes');
    assert.equal(h.of('badge_denied_repeated')[0]!.deviceId, 'P-ENTREE');
    h.fake.emitAccess({ status: 0, errorCode: 0x10, utc: utc + 52, door: 0 });
    await waitFor(() => h.of('badge_denied').length === 5, 5000, 'refus');
    assert.equal(h.of('badge_denied_repeated').length, 1, 'le compteur repart de zero');
  });

  it('porte forcee, maintenue ouverte puis fermee, ouverte, sabotage du boitier puis fin', async () => {
    const h = await boot();
    await online(h);
    await settled(h);
    h.fake.emitDoor('BreakIn', { action: 'Start', index: 0 });
    await waitFor(() => h.of('door_forced').length === 1, 5000, 'porte forcee');
    assert.equal(h.of('door_forced')[0]!.deviceId, 'P-ENTREE');
    h.fake.emitDoor('DoorNotClosed', { action: 'Start', index: 1 });
    await waitFor(() => h.of('door_held_open').length === 1, 5000, 'maintenue ouverte');
    assert.equal(h.of('door_held_open')[0]!.deviceId, 'P-SALLE');
    h.fake.emitDoor('DoorNotClosed', { action: 'Stop', index: 1 });
    await waitFor(() => h.of('door_closed', 'P-SALLE').length === 1, 5000, 'fin de maintien');
    h.fake.emitDoor('DoorStatus', { index: 0, data: { Status: 'Close' } });
    await waitFor(() => h.of('door_closed', 'P-ENTREE').length === 1, 5000, 'porte refermee');
    h.fake.emitDoor('DoorStatus', { index: 0, data: { Status: 'Open' } });
    await waitFor(() => h.of('door_opened').length === 1, 5000, 'porte ouverte');
    h.fake.emitDoor('ChassisIntruded', { action: 'Start', index: 0, data: null });
    await waitFor(() => h.of('tamper').length === 2, 5000, 'sabotage sur les deux portes');
    assert.deepEqual(h.of('tamper').map((s) => s.deviceId).sort(), ['P-ENTREE', 'P-SALLE']);
    h.fake.emitDoor('ChassisIntruded', { action: 'Stop', index: 0, data: null });
    await waitFor(() => h.of('restored').length === 2, 5000, 'fin de sabotage');
    for (const s of h.sent) assert.equal(prepare(s.deviceId, s.msg, h.clock.t).ok, true, JSON.stringify(s.msg));
    for (const s of h.sent) if (s.msg.event) assert.ok(KNOWN_EVENTS.has(s.msg.event), s.msg.event);
  });

  it('evenements inconnus, JSON illisible et alarmes de contrainte : ignores sans casser le flux', async () => {
    const h = await boot();
    await online(h);
    await settled(h);
    const before = h.sent.length;
    h.fake.emitDoor('Duress', { action: 'Start', index: 0, data: {} });
    h.fake.emitDoor('VideoMotion', { action: 'Start', index: 0, data: {} });
    h.fake.emitRaw('Code=AccessControl;action=Pulse;index=0;data={pas du json');
    h.fake.emitRaw('n\'importe quoi');
    h.fake.emitDoor('BreakIn', { action: 'Start', index: 0 });
    await waitFor(() => h.of('door_forced').length === 1, 5000, 'le flux continue');
    assert.equal(h.sent.length, before + 1);
    assert.ok(h.logs.some((l) => /contrainte/.test(l)), 'la contrainte non transmise est signalee');
  });

  it('numero de badge, nom et code saisi : jamais dans les journaux ; le PIN ne ressort nulle part', async () => {
    const h = await boot();
    await online(h);
    await settled(h);
    h.fake.emitAccess({ recNo: 1, cardNo: '5551234', cardName: 'DUPONT Marie', method: 0, password: 'PIN-4242' });
    h.fake.emitAccess({ recNo: 2, cardNo: '5559999', cardName: 'DUPONT Marie', method: 1, password: 'PIN-4242', status: 0, errorCode: 0x10 });
    await waitFor(() => accessMsgs(h).length === 2, 5000, 'passages');
    assert.equal(accessMsgs(h)[0]!.msg.access!.credential, null, 'mode code : pas de numero');
    const everything = JSON.stringify(h.sent) + h.logs.join('\n');
    assert.equal(/PIN-4242|4242/.test(everything), false);
    assert.equal(/5551234|5559999|DUPONT/.test(h.logs.join('\n')), false);
    assert.equal(/Mot-de-passe-Dahua|127\.0\.0\.1/.test(h.logs.join('\n')), false);
  });

  it('controleur coupe : toutes les portes hors ligne apres la grace, UNE seule fois ; retour => signe de vie', async () => {
    const h = await boot();
    await online(h);
    await settled(h);
    const hb = h.events('P-ENTREE').filter((e) => e === 'heartbeat').length;
    await h.fake.pause();
    await waitFor(() => h.mod.all[0]!.state().phase === 'waiting', 5000, 'coupure vue');
    await h.advance(5_000);
    assert.equal(h.of('state:offline').length, 0, 'delai de grace');
    await h.advance(11_000);
    assert.deepEqual(h.of('state:offline').map((s) => s.deviceId).sort(), ['P-ENTREE', 'P-SALLE']);
    for (let i = 0; i < 6; i++) await h.advance(20_000, { settle: false });
    assert.equal(h.of('state:offline').length, 2, 'une seule fois par porte');
    assert.equal(h.events('P-ENTREE').filter((e) => e === 'heartbeat').length, hb, 'aucun signe de vie tant que la panne dure');
    await h.fake.resume();
    await online(h);
    await waitFor(() => h.events('P-ENTREE').filter((e) => e === 'heartbeat').length === hb + 1 && h.events('P-SALLE').filter((e) => e === 'heartbeat').length === hb + 1, 8000, 'signe de vie au retour');
    assert.equal(h.of('state:offline').length, 2);
    assert.ok(h.fake.attaches >= 2);
  });

  it('coupure breve (avant la fin de la grace) : jamais hors ligne', async () => {
    const h = await boot();
    await online(h);
    await settled(h);
    h.fake.dropAll();
    await h.advance(3_000, { settle: false });
    await online(h);
    await h.advance(60_000);
    assert.equal(h.of('state:offline').length, 0);
  });

  it('flux ouvert mais MUET : plus de signe de vie, flux relance, puis hors ligne', async () => {
    const h = await boot();
    await online(h);
    await settled(h);
    const hb = h.events('P-ENTREE').filter((e) => e === 'heartbeat').length;
    h.fake.setMuted(true);
    await h.advance(31_000, { settle: false });
    await waitFor(() => h.mod.all[0]!.state().phase !== 'connected', 3000, 'flux muet detecte');
    await h.advance(20_000, { settle: false });
    await h.advance(20_000, { settle: false });
    assert.deepEqual(h.of('state:offline').map((s) => s.deviceId).sort(), ['P-ENTREE', 'P-SALLE']);
    assert.equal(h.events('P-ENTREE').filter((e) => e === 'heartbeat').length, hb);
    assert.ok(h.logs.some((l) => /flux muet/.test(l)));
    assert.ok(h.fake.openStreams <= 1, 'jamais deux flux');
    // Le controleur reparle : retour.
    h.fake.setMuted(false);
    h.fake.cutStream();
    await waitFor(() => h.mod.all[0]!.supervisor.state().online, 25_000, 'retour apres silence');
  });

  it('derive d\'horloge : +5 min => clock_drift par porte ; retour a l\'heure => restored', async () => {
    const h = await boot();
    await online(h);
    await settled(h);
    assert.equal(h.of('clock_drift').length, 0);
    h.fake.setClockOffset(5 * 60_000);
    h.fake.cutStream();
    await waitFor(() => h.of('clock_drift').length === 2, 8000, 'derive signalee');
    assert.deepEqual(h.of('clock_drift').map((s) => s.deviceId).sort(), ['P-ENTREE', 'P-SALLE']);
    assert.equal(h.mod.all[0]!.supervisor.state().drifting, true);
    h.fake.setClockOffset(0);
    await h.advance(301_000);
    await waitFor(() => h.of('restored').length === 2, 8000, 'retour a l\'heure');
    assert.equal(h.mod.all[0]!.supervisor.state().drifting, false);
  });

  it('un controleur dont l\'horloge est decalee date ses passages a SON heure (conservee), derive signalee', async () => {
    const h = await boot();
    await online(h);
    await settled(h);
    h.fake.setClockOffset(10 * 60_000);
    h.fake.emitAccess({ recNo: 5 });
    await waitFor(() => accessMsgs(h).length === 1, 5000, 'passage');
    assert.equal(accessMsgs(h)[0]!.msg.ts, T0 + 10 * 60_000);
  });
});

describe('acces-dahua : recuperation des passages manques (F8)', () => {
  it('passages stockes pendant une coupure : rejoues « differes », dans l\'ordre, sans doublon avec le flux direct', async () => {
    const h = await boot();
    await online(h);
    await settled(h);
    h.fake.emitAccess({ recNo: 1 });
    await waitFor(() => accessMsgs(h).length === 1, 5000, 'passage direct');
    await h.fake.pause();
    await waitFor(() => h.mod.all[0]!.state().phase === 'waiting', 5000, 'coupure');
    // Pendant la coupure, dans le desordre de numeros (le controleur numerote, nous rejouons par numero croissant).
    h.fake.emitAccess({ recNo: 4, cardNo: '0000004', utc: Math.floor(T0 / 1000) + 4 });
    h.fake.emitAccess({ recNo: 2, cardNo: '0000002', utc: Math.floor(T0 / 1000) + 2 });
    h.fake.emitAccess({ recNo: 3, cardNo: '0000003', utc: Math.floor(T0 / 1000) + 3, status: 0, errorCode: 0x15 });
    await h.fake.resume();
    await waitFor(() => accessMsgs(h).length === 4, 10_000, 'passages recuperes');
    await sleep(300);
    const msgs = accessMsgs(h).map((s) => s.msg);
    assert.deepEqual(msgs.map((m) => m.access!.eventId), ['1', '2', '3', '4'], 'ordre croissant, aucun doublon');
    assert.deepEqual(msgs.map((m) => m.access!.deferred), [false, true, true, true]);
    assert.equal(msgs[2]!.event, 'badge_denied');
    assert.equal(msgs[2]!.access!.reason, 'antipassback');
    assert.deepEqual(msgs.slice(1).map((m) => m.ts), [T0 + 2000, T0 + 3000, T0 + 4000], 'heure du controleur');
    for (const s of accessMsgs(h)) assert.equal(prepare(s.deviceId, s.msg, h.clock.t).ok, true);
  });

  it('un passage direct arrive PENDANT la recuperation n\'est pas perdu et ne double pas ; l\'ordre reste croissant', async () => {
    const h = await boot();
    await online(h);
    await settled(h);
    await h.fake.pause();
    await waitFor(() => h.mod.all[0]!.state().phase === 'waiting', 5000, 'coupure');
    for (let n = 1; n <= 30; n++) h.fake.emitAccess({ recNo: n, send: false, cardNo: `C${n}`, utc: Math.floor(T0 / 1000) + n });
    h.fake.latencyMs = 25; // la recuperation dure assez longtemps pour qu'un passage direct arrive au milieu
    await h.fake.resume();
    await waitFor(() => h.fake.attaches >= 2 && h.mod.all[0]!.state().phase === 'connected', 8000, 'reconnecte');
    h.fake.emitAccess({ recNo: 31, cardNo: 'C31', utc: Math.floor(T0 / 1000) + 31 });
    await waitFor(() => accessMsgs(h).length === 31, 12_000, 'tous les passages');
    await sleep(300);
    const ids = accessMsgs(h).map((s) => Number(s.msg.access!.eventId));
    assert.deepEqual(ids, Array.from({ length: 31 }, (_, i) => i + 1));
    // Le passage 31 est aussi dans la memoire du controleur : une seule copie part (peu importe laquelle).
    assert.equal(accessMsgs(h)[29]!.msg.access!.deferred, true);
  });

  it('premier demarrage : seules les dernieres 24 h sont rejouees (pas tout l\'historique)', async () => {
    const clock = { t: T0 };
    const fake = await startFake({ now: () => clock.t });
    const nowSec = Math.floor(T0 / 1000);
    fake.emitAccess({ recNo: 1, send: false, utc: nowSec - 3 * 86400 });
    fake.emitAccess({ recNo: 2, send: false, utc: nowSec - 25 * 3600 });
    fake.emitAccess({ recNo: 3, send: false, utc: nowSec - 23 * 3600 });
    fake.emitAccess({ recNo: 4, send: false, utc: nowSec - 60 });
    const h = await boot({ fake, clock });
    await waitFor(() => accessMsgs(h).length === 2, 8000, 'passages des 24 dernieres heures');
    await sleep(200);
    assert.deepEqual(accessMsgs(h).map((s) => s.msg.access!.eventId), ['3', '4']);
    assert.ok(accessMsgs(h).every((s) => s.msg.access!.deferred === true));
  });

  it('redemarrage du module : le curseur persiste, seuls les NOUVEAUX passages sont rejoues', async () => {
    const clock = { t: T0 };
    const fake = await startFake({ now: () => clock.t });
    const stateDir = tempDir(cleanup);
    const h1 = await boot({ fake, clock, stateDir });
    await online(h1);
    await settled(h1);
    fake.emitAccess({ recNo: 1, utc: Math.floor(T0 / 1000) });
    fake.emitAccess({ recNo: 2, utc: Math.floor(T0 / 1000) + 1 });
    await waitFor(() => accessMsgs(h1).length === 2, 5000, 'deux passages');
    await h1.stop();
    // Pendant l'arret du module, deux passages de plus.
    fake.emitAccess({ recNo: 3, utc: Math.floor(T0 / 1000) + 2 });
    fake.emitAccess({ recNo: 4, utc: Math.floor(T0 / 1000) + 3 });
    clock.t += 1000;
    const h2 = await boot({ fake, clock, stateDir });
    await waitFor(() => accessMsgs(h2).length === 2, 8000, 'nouveaux passages');
    await sleep(300);
    assert.deepEqual(accessMsgs(h2).map((s) => s.msg.access!.eventId), ['3', '4']);
    assert.ok(accessMsgs(h2).every((s) => s.msg.access!.deferred));
  });

  it('message refuse par le socle (emit renvoie false) : curseur non avance, rejoue des que possible, sans doublon', async () => {
    const h = await boot();
    await online(h);
    await settled(h);
    h.refuse.on = true;
    h.fake.emitAccess({ recNo: 1, cardNo: 'REFUSE1', utc: Math.floor(T0 / 1000) });
    await waitFor(() => h.logs.some((l) => /refuse par la passerelle/.test(l)), 5000, 'refus du socle constate');
    h.refuse.on = false;
    h.fake.emitAccess({ recNo: 2, cardNo: 'OK2', utc: Math.floor(T0 / 1000) + 1 });
    await waitFor(() => accessMsgs(h).length === 1, 5000, 'passage suivant');
    assert.equal(accessMsgs(h)[0]!.msg.access!.eventId, '2');
    await h.advance(3_000);
    await waitFor(() => accessMsgs(h).length === 2, 10_000, 'passage refuse rejoue');
    await sleep(300);
    assert.deepEqual(accessMsgs(h).map((s) => s.msg.access!.eventId).sort(), ['1', '2']);
    assert.equal(accessMsgs(h).find((s) => s.msg.access!.eventId === '1')!.msg.access!.deferred, true);
  });

  it('socle plein pendant toute la recuperation : arret, puis reprise a la reconnexion', async () => {
    const h = await boot();
    await online(h);
    await settled(h);
    await h.fake.pause();
    await waitFor(() => h.mod.all[0]!.state().phase === 'waiting', 5000, 'coupure');
    for (let n = 1; n <= 5; n++) h.fake.emitAccess({ recNo: n, send: false, utc: Math.floor(T0 / 1000) + n });
    h.refuse.on = true;
    await h.fake.resume();
    await waitFor(() => h.mod.all[0]!.state().phase === 'connected', 8000, 'reconnecte');
    await sleep(400);
    assert.equal(accessMsgs(h).length, 0);
    h.refuse.on = false;
    h.fake.cutStream();
    await waitFor(() => accessMsgs(h).length === 5, 12_000, 'tout rejoue a la reconnexion');
    await sleep(200);
    assert.deepEqual(accessMsgs(h).map((s) => s.msg.access!.eventId), ['1', '2', '3', '4', '5']);
  });

  it('plus de pages que la page n\'en tient : pagination par fenetres de temps, aucun doublon ni trou', async () => {
    const h = await boot({ fakeOpts: { pageCap: 7 } });
    await online(h);
    await settled(h);
    await h.fake.pause();
    await waitFor(() => h.mod.all[0]!.state().phase === 'waiting', 5000, 'coupure');
    for (let n = 1; n <= 40; n++) h.fake.emitAccess({ recNo: n, send: false, utc: Math.floor(T0 / 1000) + Math.floor(n / 3) });
    await h.fake.resume();
    await waitFor(() => accessMsgs(h).length === 40, 15_000, '40 passages');
    await sleep(300);
    assert.deepEqual(accessMsgs(h).map((s) => Number(s.msg.access!.eventId)), Array.from({ length: 40 }, (_, i) => i + 1));
  });

  it('memoire du controleur illisible (HTTP 404) : signale une fois, le flux direct continue', async () => {
    const h = await boot({ fakeOpts: { recordFinder: false } });
    await online(h);
    await waitFor(() => h.logs.some((l) => /ne pourront pas etre rejoues/.test(l)), 8000, 'avertissement');
    await sleep(200);
    h.fake.emitAccess({ recNo: 9 });
    await waitFor(() => accessMsgs(h).length === 1, 5000, 'passage direct');
    assert.equal(accessMsgs(h)[0]!.msg.access!.deferred, false);
    assert.equal(h.logs.filter((l) => /ne pourront pas etre rejoues/.test(l)).length, 1);
  });

  it('evenement du flux SANS RecNo : complete par la memoire (identifiant = n° d\'enregistrement), un seul message', async () => {
    const h = await boot();
    await online(h);
    await settled(h);
    h.fake.emitAccess({ recNo: 55, streamRecNo: false, cardNo: '0001111' });
    await waitFor(() => accessMsgs(h).length >= 1, 8000, 'passage complete');
    await sleep(500);
    await h.advance(5_000);
    assert.equal(accessMsgs(h).length, 1, 'ni doublon ni identifiant synthetique en plus');
    assert.equal(accessMsgs(h)[0]!.msg.access!.eventId, '55');
    assert.equal(accessMsgs(h)[0]!.msg.access!.deferred, false);
  });

  it('evenement sans RecNo et memoire illisible : identifiant synthetique deterministe apres quelques secondes', async () => {
    const h = await boot({ fakeOpts: { recordFinder: false } });
    await online(h);
    await waitFor(() => h.logs.some((l) => /ne pourront pas etre rejoues/.test(l)), 8000, 'memoire illisible constatee');
    h.fake.emitAccess({ recNo: 1, streamRecNo: false, send: true, store: false, cardNo: '0002222' });
    await waitFor(() => accessMsgs(h).length === 1, 5000, 'passage');
    assert.match(accessMsgs(h)[0]!.msg.access!.eventId, /^x\d+\.1\.[0-9a-f]{8}$/);
    assert.equal(accessMsgs(h)[0]!.msg.msgId, `acc:CTL-1:${accessMsgs(h)[0]!.msg.access!.eventId}`);
  });

  it('evenement sans RecNo jamais confirme par la memoire : emis avec son identifiant synthetique apres la grace', async () => {
    const h = await boot();
    await online(h);
    await settled(h);
    h.fake.emitAccess({ recNo: 1, streamRecNo: false, store: false, cardNo: '0003333' });
    await sleep(500);
    assert.equal(accessMsgs(h).length, 0, 'retenu pendant la grace');
    await h.advance(4_000);
    await waitFor(() => accessMsgs(h).length === 1, 5000, 'emis apres la grace');
    assert.match(accessMsgs(h)[0]!.msg.access!.eventId, /^x/);
    await h.advance(30_000);
    assert.equal(accessMsgs(h).length, 1, 'une seule fois');
  });
});

describe('acces-dahua : etat des portes au retour de la liaison', () => {
  it('getDoorStatus : door_opened / door_closed exacts a la connexion', async () => {
    const clock = { t: T0 };
    const fake = await startFake({ now: () => clock.t });
    fake.doorStates[0] = 'Open';
    fake.doorStates[1] = 'Close';
    const h = await boot({ fake, clock });
    await waitFor(() => h.of('door_opened', 'P-ENTREE').length === 1 && h.of('door_closed', 'P-SALLE').length === 1, 8000, 'etats lus');
    // L'etat lu est date une seconde pleine plus tot que la lecture : un evenement du controleur (date a la seconde) arrive pendant
    // la lecture n'est jamais pris pour plus ancien par le PSIM.
    assert.equal(h.of('door_opened', 'P-ENTREE')[0]!.msg.ts, T0 - 1000);
  });

  it('commande non prise en charge (404) : seul le signe de vie, une seule tentative', async () => {
    const clock = { t: T0 };
    const fake = await startFake({ now: () => clock.t, getDoorStatus: false });
    const h = await boot({ fake, clock });
    await online(h);
    await settled(h);
    await sleep(200);
    assert.equal(h.of('door_opened').length + h.of('door_closed').length, 0);
    assert.equal(fake.requests.filter((r) => r.path.includes('getDoorStatus')).length, 1, 'abandonne a la premiere reponse 404');
  });
});

describe('acces-dahua : identifiants refuses et reconnexion', () => {
  class ManualTimers implements Timers {
    list: { id: number; fn: () => void; ms: number }[] = [];
    private next = 1;
    setTimeout(fn: () => void, ms: number): unknown {
      const id = this.next++;
      this.list.push({ id, fn, ms });
      return id;
    }
    clearTimeout(handle: unknown): void {
      this.list = this.list.filter((t) => t.id !== handle);
    }
    /** Declenche la plus ancienne minuterie en attente ; rend son delai. */
    fire(): number {
      const t = this.list.shift();
      assert.ok(t, 'aucune minuterie en attente');
      t.fn();
      return t.ms;
    }
  }

  it('identifiants refuses : UN seul essai, puis attente de 5 min (pas d\'inondation) ; reprise apres l\'attente', async () => {
    const timers = new ManualTimers();
    const clock = { t: T0 };
    const fake = await startFake({ now: () => clock.t });
    fake.failAuth(1_000_000);
    const h = await boot({ fake, clock, internals: { timers } });
    await waitFor(() => fake.authRejected >= 1, 5000, 'premier refus');
    await sleep(400);
    assert.equal(fake.authRejected, 1, 'un seul essai authentifie');
    assert.equal(timers.list.length, 1);
    assert.ok(timers.list[0]!.ms >= AUTH_BLOCK_MS, `attente de ${timers.list[0]!.ms} ms`);
    assert.ok(h.logs.some((l) => /identifiants refuses/.test(l)));
    assert.equal(/Mot-de-passe/.test(h.logs.join('\n')), false);
    // L'attente passe : un nouvel essai, qui reussit.
    fake.failAuth(0);
    clock.t += AUTH_BLOCK_MS + 1;
    timers.fire();
    await online(h);
    assert.equal(fake.authRejected, 1);
    // Aucune porte n'est restee « en ligne » entre-temps : hors ligne apres la grace.
  });

  it('identifiants refuses des le depart : portes hors ligne apres la grace, une seule fois', async () => {
    const timers = new ManualTimers();
    const clock = { t: T0 };
    const fake = await startFake({ now: () => clock.t });
    fake.failAuth(1_000_000);
    const h = await boot({ fake, clock, internals: { timers } });
    await waitFor(() => fake.authRejected >= 1, 5000, 'refus');
    await h.advance(16_000, { settle: false });
    await h.advance(60_000, { settle: false });
    assert.deepEqual(h.of('state:offline').map((s) => s.deviceId).sort(), ['P-ENTREE', 'P-SALLE']);
    assert.equal(fake.authRejected, 1);
  });

  function stubOpen() {
    const opened: { handlers: { onPart: (b: string) => void; onEnd: (r: string, a?: boolean) => void }; stopped: boolean }[] = [];
    let active = 0;
    let maxActive = 0;
    const open = ((_creds: unknown, handlers: { onPart: (b: string) => void; onEnd: (r: string, a?: boolean) => void }) => {
      const rec = { handlers, stopped: false };
      opened.push(rec);
      active++;
      maxActive = Math.max(maxActive, active);
      return {
        ready: new Promise<void>(() => undefined),
        stop: () => {
          if (!rec.stopped) {
            rec.stopped = true;
            active--;
          }
        },
      };
    }) as unknown as NonNullable<Parameters<typeof createModule>[1]>['open'];
    return { open, opened, max: () => maxActive };
  }

  it('reconnexion a attente croissante (min, 2 min, 4 min... plafonnee a max), remise a zero apres une connexion stable', async () => {
    const timers = new ManualTimers();
    const stub = stubOpen();
    const h = await boot({ internals: { timers, open: stub.open }, reconnect: { minMs: 100, maxMs: 700 }, fakeOpts: {} });
    assert.equal(stub.opened.length, 1);
    const waits: number[] = [];
    for (let i = 0; i < 6; i++) {
      stub.opened.at(-1)!.handlers.onEnd('connexion coupee par le controleur');
      waits.push(timers.list.at(-1)!.ms);
      timers.fire();
    }
    assert.deepEqual(waits, [100, 200, 400, 700, 700, 700]);
    assert.equal(stub.opened.length, 7);
    // Une connexion qui dure (au moins 5 x minMs, 2 s au minimum) remet l'attente a zero.
    stub.opened.at(-1)!.handlers.onPart('Heartbeat');
    h.clock.t += 5_000;
    stub.opened.at(-1)!.handlers.onEnd('flux ferme par l\'appareil');
    assert.equal(timers.list.at(-1)!.ms, 100);
    timers.fire();
    // Une connexion courte ne la remet pas a zero.
    stub.opened.at(-1)!.handlers.onPart('Heartbeat');
    h.clock.t += 500;
    stub.opened.at(-1)!.handlers.onEnd('flux ferme par l\'appareil');
    assert.equal(timers.list.at(-1)!.ms, 200);
  });

  it('jamais deux flux en meme temps, meme si le flux signale sa fin plusieurs fois ou si tick() est appele sans cesse', async () => {
    const timers = new ManualTimers();
    const stub = stubOpen();
    const h = await boot({ internals: { timers, open: stub.open } });
    for (let i = 0; i < 20; i++) {
      const last = stub.opened.at(-1)!;
      last.handlers.onEnd('a');
      last.handlers.onEnd('b');
      last.handlers.onEnd('c', true);
      h.mod.tick();
      h.mod.tick();
      if (timers.list.length > 0) timers.fire();
    }
    assert.equal(stub.max(), 1);
    assert.equal(timers.list.length <= 1, true);
    // Des rappels tardifs d'un ancien flux sont ignores.
    const old = stub.opened[0]!;
    old.handlers.onPart('Code=AccessControl;action=Pulse;index=0;data={"CardNo":"1","RecNo":1,"UTC":1760000000}');
    assert.equal(h.sent.filter((s) => s.msg.access).length, 0);
  });

  it('flux ouvert mais jamais de partie : aucune porte donnee en ligne', async () => {
    const timers = new ManualTimers();
    const stub = stubOpen();
    const h = await boot({ internals: { timers, open: stub.open } });
    await h.advance(40_000, { settle: false });
    await h.advance(40_000, { settle: false });
    assert.deepEqual(h.of('state:offline').map((s) => s.deviceId).sort(), ['P-ENTREE', 'P-SALLE']);
    assert.equal(h.of('heartbeat').length, 0);
  });
});

describe('acces-dahua : actionneurs enregistres par le module', () => {
  it('chaque actionneur declare est enregistre ; un ordre signe arrive jusqu\'au controleur', async () => {
    const h = await boot();
    assert.deepEqual([...h.actuators.keys()].sort(), ['ACT-BARRIERE', 'ACT-ENTREE']);
    assert.deepEqual(await h.actuators.get('ACT-ENTREE')!(req('unlock')), { result: 'done' });
    assert.deepEqual(h.fake.commands.map((c) => [c.action, c.channel]), [['openDoor', 1]]);
    assert.deepEqual(await h.actuators.get('ACT-BARRIERE')!(req('open')), { result: 'done' });
    assert.deepEqual(h.fake.commands.map((c) => [c.action, c.channel]), [['openDoor', 1], ['openDoor', 2]]);
    assert.deepEqual(await h.actuators.get('ACT-BARRIERE')!(req('stop')), { result: 'refused', code: 'not_supported' });
    assert.deepEqual(await h.actuators.get('ACT-ENTREE')!(req('lock')), { result: 'done' });
    assert.equal(h.fake.modes.includes('CloseAlways'), false);
  });

  it('sans canal de commande (pas de onActuator) : le module surveille quand meme, avertissement', async () => {
    const fake = await startFake({ now: () => T0 });
    const sent: Sent[] = [];
    const logs: string[] = [];
    const ctx = { emit: (id: string, msg: DeviceMessage) => (sent.push({ deviceId: id, msg }), true), openMqtt: async () => { throw new Error('x'); }, log: (_l: string, t: string) => void logs.push(t), config: {}, now: () => T0 } as unknown as ModuleContext;
    const mod = createModule(configFor(fake, tempDir(cleanup)), { tickMs: null });
    cleanup.push(() => mod.stop());
    await mod.start(ctx);
    await waitFor(() => mod.all[0]!.supervisor.state().online, 8000, 'en ligne');
    assert.ok(logs.some((l) => /ouverture a distance indisponible/.test(l)));
  });
});

describe('acces-dahua : arret propre', () => {
  it('stop() ferme le flux, annule les requetes en cours, ecrit le curseur ; idempotent', async () => {
    const h = await boot();
    await online(h);
    await settled(h);
    h.fake.emitAccess({ recNo: 8 });
    await waitFor(() => accessMsgs(h).length === 1, 5000, 'passage');
    h.fake.behavior.openDoor = 'hang';
    const pending = h.actuators.get('ACT-ENTREE')!(req('unlock'));
    await sleep(100);
    await h.stop();
    await h.stop();
    assert.equal((await pending).result, 'error');
    await waitFor(() => h.fake.openStreams === 0, 3000, 'flux ferme');
    const { readFileSync } = await import('node:fs');
    const saved = JSON.parse(readFileSync(join(h.stateDir, 'acces-curseurs.json'), 'utf8')) as { controllers: Record<string, { cursor: string }> };
    assert.equal(saved.controllers['CTL-1']!.cursor, '8');
    const attaches = h.fake.attaches;
    await sleep(600);
    assert.equal(h.fake.attaches, attaches, 'plus aucune reconnexion apres l\'arret');
    h.mod.tick(); // sans effet
  });

  it('arret pendant la connexion ou la recuperation : aucune exception, aucune promesse perdue', async () => {
    const fake = await startFake({ now: () => T0 });
    for (let i = 0; i < 6; i++) {
      fake.latencyMs = 20;
      for (let n = 1; n <= 10; n++) fake.emitAccess({ recNo: n + i * 10, send: false, utc: Math.floor(T0 / 1000) + n });
      const h = await boot({ fake, stateDir: tempDir(cleanup) });
      await sleep(i * 40);
      await h.stop();
    }
    await sleep(200);
    assert.deepEqual(unhandled, []);
  });

  it('le processus se termine tout seul apres stop() : aucune minuterie ni connexion restante', async () => {
    const mod = pathToFileURL(join(ROOT, 'gateway', 'src', 'modules', 'acces-dahua', 'index.ts')).href;
    const fakeUrl = pathToFileURL(join(ROOT, 'gateway', 'test', 'fake-dahua.ts')).href;
    const dir = tempDir(cleanup).replace(/\\/g, '/');
    const script = `
      import { FakeDahua } from ${JSON.stringify(fakeUrl)};
      import { create } from ${JSON.stringify(mod)};
      const fake = await FakeDahua.start({ heartbeatMs: 40 });
      const sent = [];
      const ctx = { emit: (id, msg) => (sent.push(msg), true), openMqtt: async () => { throw new Error('x'); }, log: () => {}, config: {}, now: Date.now };
      const m = create({ stateDir: ${JSON.stringify(dir)}, controllers: [{ id: 'CTL-1', host: '127.0.0.1', port: fake.port, username: fake.username, password: fake.password, doors: { '1': 'P-1' } }], reconnect: { minMs: 50, maxMs: 200 } });
      await m.start(ctx);
      fake.emitAccess({ recNo: 1 });
      const t0 = Date.now();
      while (!sent.some((s) => s.access) && Date.now() - t0 < 8000) await new Promise((r) => setTimeout(r, 20));
      if (!sent.some((s) => s.access)) { console.log('PAS DE PASSAGE'); process.exit(3); }
      await m.stop();
      await fake.close();
      console.log('FINI');
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    const code = await new Promise<number | null>((resolve) => {
      const killer = setTimeout(() => (child.kill('SIGKILL'), resolve(null)), 15_000);
      child.on('exit', (c) => (clearTimeout(killer), resolve(c)));
    });
    assert.equal(code, 0, `le processus ne s'est pas termine (${out.slice(0, 300)})`);
    assert.match(out, /FINI/);
  });
});

describe('acces-dahua : journaux', () => {
  it('rien de sensible dans aucun journal de ces essais (badge, nom, mot de passe, adresse)', () => {
    const text = allLogs.join('\n');
    assert.equal(/0012345|0099999|KONAN|DUPONT|Mot-de-passe-Dahua|127\.0\.0\.1|PIN-/.test(text), false);
    assert.ok(allLogs.length > 0);
  });
});
