/** Application agent : main courante (partie pure de web/agent/logbook.js). */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
// @ts-expect-error module JS de l'interface (sans types), importe pour tester ses calculs purs
import { buildLogbookPayload, CATEGORIES } from '../web/agent/logbook.js';

const base = { category: 'anomaly', text: 'Porte du local technique ouverte', clientId: 'c1', now: 1700000000000 };

describe('application agent : buildLogbookPayload', () => {
  it('accepte les quatre categories', () => {
    assert.deepEqual(CATEGORIES.map((c: { id: string }) => c.id), ['anomaly', 'damage', 'visitor', 'other']);
    for (const category of ['anomaly', 'damage', 'visitor', 'other']) {
      const r = buildLogbookPayload({ ...base, category });
      assert.equal(r.ok, true);
      assert.equal(r.payload.category, category);
    }
  });
  it('refuse une categorie absente ou inconnue', () => {
    assert.equal(buildLogbookPayload({ ...base, category: null }).ok, false);
    assert.equal(buildLogbookPayload({ ...base, category: 'incident' }).ok, false);
  });
  it('construit le corps attendu par le serveur', () => {
    const r = buildLogbookPayload(base);
    assert.deepEqual(r.payload, { clientId: 'c1', category: 'anomaly', text: 'Porte du local technique ouverte', phoneAt: 1700000000000 });
  });
  it('retire les espaces autour du texte et refuse un texte vide ou trop court', () => {
    assert.equal(buildLogbookPayload({ ...base, text: '  ok !  ' }).payload.text, 'ok !');
    assert.equal(buildLogbookPayload({ ...base, text: '' }).ok, false);
    assert.equal(buildLogbookPayload({ ...base, text: '    ' }).ok, false);
    assert.equal(buildLogbookPayload({ ...base, text: 'ab' }).ok, false);
    assert.equal(buildLogbookPayload({ ...base, text: undefined }).ok, false);
  });
  it('accepte 1000 caracteres et refuse 1001', () => {
    assert.equal(buildLogbookPayload({ ...base, text: 'a'.repeat(1000) }).ok, true);
    const r = buildLogbookPayload({ ...base, text: 'a'.repeat(1001) });
    assert.equal(r.ok, false);
    assert.match(r.error, /trop long/);
  });
  it('le point est facultatif', () => {
    assert.equal('checkpointId' in buildLogbookPayload(base).payload, false);
    assert.equal('checkpointId' in buildLogbookPayload({ ...base, checkpointId: '' }).payload, false);
    assert.equal(buildLogbookPayload({ ...base, checkpointId: 'cp-7' }).payload.checkpointId, 'cp-7');
  });
  it('la photo est facultative', () => {
    assert.equal('photo' in buildLogbookPayload(base).payload, false);
    assert.equal('photo' in buildLogbookPayload({ ...base, photoBase64: '' }).payload, false);
    assert.equal(buildLogbookPayload({ ...base, photoBase64: '/9j/4AAQ' }).payload.photo, '/9j/4AAQ');
  });
  it('genere un clientId et une heure si absents', () => {
    const r = buildLogbookPayload({ category: 'other', text: 'Rien à signaler ici' });
    assert.equal(typeof r.payload.clientId, 'string');
    assert.ok(r.payload.clientId.length >= 16);
    assert.ok(Math.abs(r.payload.phoneAt - Date.now()) < 5000);
  });
});
