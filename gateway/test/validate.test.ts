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
