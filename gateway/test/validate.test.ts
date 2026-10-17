/** Controle des messages avant mise en file. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EVENTS } from '../../server/sources.ts';
import { KNOWN_EVENTS, MSG_ID, prepare, topicFor } from '../src/validate.ts';

const NOW = 1_760_000_000_123;
const id = () => 'genere-1';

describe('controle des messages', () => {
  it('complete ts (heure courante, ms) et msgId (genere) quand ils manquent', () => {
    const r = prepare('D-01', { state: 'alarm' }, NOW, id);
    assert.ok(r.ok);
    assert.deepEqual(r.payload, { state: 'alarm', ts: NOW, msgId: 'genere-1' });
    assert.equal(r.topic, 'psim/detectors/D-01/state');
  });

  it("garde le ts et le msgId fournis par le module (heure reelle de l'evenement)", () => {
    const r = prepare('D-01', { event: 'gas', value: 12.5, ts: NOW - 5000, msgId: 'z2m:abc-1' }, NOW, id);
    assert.ok(r.ok);
    assert.deepEqual(r.payload, { event: 'gas', value: 12.5, ts: NOW - 5000, msgId: 'z2m:abc-1' });
  });

  it('refuse un identifiant de detecteur invalide (topic piege compris)', () => {
    for (const bad of ['', 'a/b', '+', '#', 'D 01', 'x'.repeat(33), '../D-01', 12 as unknown as string]) {
      const r = prepare(bad, { state: 'alarm' }, NOW, id);
      assert.equal(r.ok, false, String(bad));
    }
    assert.equal(topicFor('D-01'), 'psim/detectors/D-01/state');
  });

  it('refuse un message trop gros (> 1 Ko)', () => {
    const r = prepare('D-01', { event: 'x'.repeat(2000) }, NOW, id);
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /trop gros/);
  });

  it('refuse les champs invalides avec une raison claire', () => {
    const cases: [unknown, RegExp][] = [
      [{}, /message vide/],
      [{ state: 'feu' }, /state invalide/],
      [{ event: 'Gas Leak' }, /event invalide/],
      [{ value: Number.NaN }, /value invalide/],
      [{ value: 2e9 }, /value hors bornes/],
      [{ state: 'alarm', ts: 1_760_000_000 }, /ts en secondes/],
      [{ state: 'alarm', ts: 1.5e12 + 0.5 }, /ts invalide/],
      [{ state: 'alarm', msgId: '' }, /msgId invalide/],
      [{ state: 'alarm', msgId: 42 }, /msgId invalide/],
      [null, /objet attendu/],
    ];
    for (const [m, re] of cases) {
      const r = prepare('D-01', m, NOW, id);
      assert.equal(r.ok, false, JSON.stringify(m));
      assert.match((r as { error: string }).error, re);
    }
  });

  it("msgId hors format (espaces, accents, '/', trop long) : nettoye de facon deterministe, jamais refuse", () => {
    for (const bad of ['a b', 'x'.repeat(65), 'Entrée/porte 1-1760000000000-contact-1', 'é'.repeat(100), '///']) {
      const r = prepare('D-01', { state: 'alarm', msgId: bad }, NOW, id);
      assert.ok(r.ok, bad);
      const msgId = r.payload.msgId as string;
      assert.match(msgId, MSG_ID, bad);
      assert.ok(r.warnings.some((w) => /msgId hors format/.test(w)));
      const again = prepare('D-01', { state: 'alarm', msgId: bad }, NOW, id);
      assert.equal(again.ok && again.payload.msgId, msgId, 'meme entree, meme msgId');
    }
    const a = prepare('D-01', { state: 'alarm', msgId: 'a b' }, NOW, id);
    const b = prepare('D-01', { state: 'alarm', msgId: 'a/b' }, NOW, id);
    assert.notEqual(a.ok && a.payload.msgId, b.ok && b.payload.msgId, 'deux originaux differents, deux msgId differents');
  });

  it('les evenements connus sont exactement ceux du PSIM (server/sources.ts)', () => {
    assert.deepEqual([...KNOWN_EVENTS].sort(), Object.keys(EVENTS).sort());
    for (const e of ['gas', 'co', 'power_loss', 'power_restored', 'vibration', 'sos', 'fall']) assert.ok(KNOWN_EVENTS.has(e), e);
  });

  it('evenement inconnu ou champ en trop : transmis (sans le champ) avec un avertissement', () => {
    const r = prepare('D-01', { event: 'nouveau_type', extra: 1 }, NOW, id);
    assert.ok(r.ok);
    assert.deepEqual(Object.keys(r.payload), ['event', 'ts', 'msgId']);
    assert.equal(r.warnings.length, 2);
  });
});

describe('champ access (passage a une porte)', () => {
  const TS = NOW - 2000;
  const passage = (over: Record<string, unknown> = {}) => ({
    v: 1, controllerId: 'CTL-1', eventId: '123456', direction: 'in', credential: '0012345', holderName: 'KONAN Yao', holderRef: '101',
    method: 'badge', result: 'granted', reason: null, deferred: false, ...over,
  });
  const msg = (access: unknown, over: Record<string, unknown> = {}) => ({ event: 'badge_granted', ts: TS, msgId: 'acc:CTL-1:123456', access, ...over });
  const refused = (m: unknown, re: RegExp) => {
    const r = prepare('P-01', m, NOW, id);
    assert.equal(r.ok, false, JSON.stringify(m));
    assert.match((r as { error: string }).error, re);
  };

  it('le message du contrat (exemple du § 2) est accepte tel quel', () => {
    const r = prepare('P-01', msg(passage()), NOW, id);
    assert.ok(r.ok);
    assert.deepEqual(r.payload, { event: 'badge_granted', ts: TS, msgId: 'acc:CTL-1:123456', access: passage() });
    assert.deepEqual(r.warnings, []);
    assert.ok(r.bytes <= 1024);
  });

  it("le msgId manquant est fabriqué : acc:<controllerId>:<eventId> ; un autre msgId est refuse", () => {
    const r = prepare('P-01', { event: 'badge_granted', ts: TS, access: passage() }, NOW, id);
    assert.ok(r.ok);
    assert.equal(r.payload.msgId, 'acc:CTL-1:123456');
    refused(msg(passage(), { msgId: 'autre' }), /msgId d'un passage invalide/);
  });

  it('identifiants longs : msgId nettoye de facon deterministe et accepte par le PSIM', () => {
    const access = passage({ controllerId: 'C'.repeat(32), eventId: 'E'.repeat(40) });
    const r = prepare('P-01', { event: 'badge_granted', ts: TS, access }, NOW, id);
    assert.ok(r.ok);
    assert.match(r.payload.msgId as string, MSG_ID);
    const again = prepare('P-01', { event: 'badge_granted', ts: TS, access }, NOW, id);
    assert.equal(again.ok && again.payload.msgId, r.payload.msgId);
  });

  it('exige ts, un event coherent avec result, et pas de state', () => {
    refused({ event: 'badge_granted', msgId: 'acc:CTL-1:123456', access: passage() }, /exige ts/);
    refused(msg(passage(), { event: 'badge_denied' }), /exige event = badge_granted/);
    refused(msg(passage({ result: 'denied', reason: 'expired' })), /exige event = badge_denied/);
    refused(msg(passage(), { state: 'alarm' }), /pas de state/);
    const ok = prepare('P-01', msg(passage({ result: 'denied', reason: 'expired' }), { event: 'badge_denied' }), NOW, id);
    assert.ok(ok.ok);
  });

  it('refuse chaque champ invalide, champ inconnu compris (jamais de PIN ni de gabarit en plus)', () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ v: 2 }, /access\.v/],
      [{ controllerId: 'a b' }, /controllerId/],
      [{ controllerId: 'x'.repeat(33) }, /controllerId/],
      [{ eventId: '' }, /eventId/],
      [{ eventId: 'a/b' }, /eventId/],
      [{ eventId: 'e'.repeat(41) }, /eventId/],
      [{ direction: 'up' }, /direction/],
      [{ method: 'pin' }, /method/],
      [{ result: 'maybe' }, /result/],
      [{ result: 'denied', reason: 'bizarre' }, /reason/],
      [{ reason: 'expired' }, /reason doit etre null/],
      [{ deferred: 'oui' }, /deferred/],
      [{ credential: 'x'.repeat(33) }, /credential/],
      [{ credential: 12345 }, /credential/],
      [{ credential: 'ab\ncd' }, /credential/],
      [{ holderRef: 'r'.repeat(33) }, /holderRef/],
      [{ holderName: 'Konan\u0000Yao' }, /holderName/],
      [{ holderName: 42 }, /holderName/],
      [{ pin: '1234' }, /champ « pin » inconnu/],
      [{ template: 'AAAA' }, /champ « template » inconnu/],
    ];
    for (const [over, re] of cases) {
      const m = (over.result as string) === 'denied' ? msg(passage(over), { event: 'badge_denied' }) : msg(passage(over));
      refused(m, re);
    }
    for (const bad of [null, 'x', [], 7]) refused(msg(bad), /access invalide/);
  });

  it('un champ manquant est refuse (le contrat les exige tous)', () => {
    for (const key of ['v', 'controllerId', 'eventId', 'direction', 'method', 'result', 'reason', 'deferred']) {
      const a = passage() as Record<string, unknown>;
      delete a[key];
      refused(msg(a), new RegExp(key));
    }
    // credential, holderName, holderRef absents = non fournis : refuses aussi (null explicite attendu)
    for (const key of ['credential', 'holderName', 'holderRef']) {
      const a = passage() as Record<string, unknown>;
      delete a[key];
      refused(msg(a), new RegExp(key));
    }
  });

  it('null accepte pour direction, credential, holderName, holderRef', () => {
    const r = prepare('P-01', msg(passage({ direction: null, credential: null, holderName: null, holderRef: null, method: 'exit_button' })), NOW, id);
    assert.ok(r.ok);
  });

  it('holderName tronque a 64 caracteres (sans couper un emoji), avec un avertissement', () => {
    const long = 'é'.repeat(63) + '😀😀😀';
    const r = prepare('P-01', msg(passage({ holderName: long })), NOW, id);
    assert.ok(r.ok);
    const name = (r.payload.access as { holderName: string }).holderName;
    assert.equal(Array.from(name).length, 64);
    assert.ok(name.endsWith('😀'));
    assert.ok(r.warnings.some((w) => /holderName tronque a 64/.test(w)));
  });

  it('cas extreme (tous les champs au maximum, nom en emoji) : le message reste sous 1 024 octets', () => {
    // Avec un nom borne a 64 caracteres le plafond de 1 024 octets ne peut pas etre atteint ; la reduction du nom dans
    // prepare() n'est qu'une securite si les bornes changent.
    const access = passage({ controllerId: 'C'.repeat(32), eventId: 'E'.repeat(40), credential: 'c'.repeat(32), holderRef: 'r'.repeat(32), holderName: '😀'.repeat(64) });
    const r = prepare('P-01', { event: 'badge_granted', ts: TS, access }, NOW, id);
    assert.ok(r.ok);
    assert.ok(r.bytes <= 1024, String(r.bytes));
    assert.equal(Buffer.byteLength(JSON.stringify(r.payload)), r.bytes);
  });

  it('les autres messages de porte (heartbeat, door_forced, offline) passent sans access', () => {
    for (const m of [{ event: 'heartbeat' }, { event: 'door_forced', ts: TS }, { state: 'offline' }, { event: 'clock_drift' }]) {
      const r = prepare('P-01', m, NOW, id);
      assert.ok(r.ok, JSON.stringify(m));
      assert.deepEqual(r.warnings, []);
    }
    assert.ok(KNOWN_EVENTS.has('clock_drift'));
  });
});

describe('mode de la porte (door_mode, F19)', () => {
  it('door_mode + doorMode valides sont transmis ; ts et msgId facultatifs', () => {
    for (const doorMode of ['normal', 'always_open', 'always_closed']) {
      const r = prepare('P-01', { event: 'door_mode', doorMode }, NOW, id);
      assert.ok(r.ok, doorMode);
      assert.deepEqual(r.payload, { event: 'door_mode', ts: NOW, msgId: 'genere-1', doorMode });
      assert.deepEqual(r.warnings, []);
    }
  });

  it('refuse un mode inconnu, un mode sans door_mode et door_mode sans mode', () => {
    const cases: [unknown, RegExp][] = [
      [{ event: 'door_mode', doorMode: 'ouverte' }, /doorMode invalide/],
      [{ event: 'door_mode', doorMode: 3 }, /doorMode invalide/],
      [{ event: 'door_mode' }, /door_mode exige doorMode/],
      [{ event: 'heartbeat', doorMode: 'normal' }, /doorMode exige event = door_mode/],
      [{ state: 'normal', doorMode: 'normal' }, /doorMode exige event = door_mode/],
    ];
    for (const [m, re] of cases) {
      const r = prepare('P-01', m, NOW, id);
      assert.equal(r.ok, false, JSON.stringify(m));
      assert.match((r as { error: string }).error, re);
    }
  });

  it('door_mode est un signe de vie connu du PSIM (alive), libelle « Mode de la porte »', () => {
    assert.ok(KNOWN_EVENTS.has('door_mode'));
    assert.equal(EVENTS.door_mode, 'alive');
  });
});
