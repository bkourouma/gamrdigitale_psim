/** Application agent : reduction de photo (calculs purs de web/agent/photo.js). */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
// @ts-expect-error module JS de l'interface (sans types), importe pour tester ses calculs purs
import { base64Length, fitSize, nextAttempt } from '../web/agent/photo.js';

describe('application agent : fitSize', () => {
  it('reduit un paysage sur la largeur', () => {
    assert.deepEqual(fitSize(4000, 3000), { width: 1280, height: 960 });
  });
  it('reduit un portrait sur la hauteur', () => {
    assert.deepEqual(fitSize(3000, 4000), { width: 960, height: 1280 });
  });
  it("n'agrandit jamais une petite image", () => {
    assert.deepEqual(fitSize(800, 600), { width: 800, height: 600 });
    assert.deepEqual(fitSize(1280, 720), { width: 1280, height: 720 });
  });
  it('respecte un maximum donne et garde au moins 1 pixel', () => {
    assert.deepEqual(fitSize(2000, 1000, 500), { width: 500, height: 250 });
    assert.deepEqual(fitSize(10000, 1, 100), { width: 100, height: 1 });
  });
});

describe('application agent : base64Length', () => {
  it('calcule la longueur avec bourrage', () => {
    assert.equal(base64Length(0), 0);
    assert.equal(base64Length(1), 4);
    assert.equal(base64Length(3), 4);
    assert.equal(base64Length(4), 8);
    assert.equal(base64Length(300 * 1024), 409600);
  });
});

describe('application agent : nextAttempt', () => {
  it("baisse la qualite par pas de 0,1 jusqu'a 0,4", () => {
    let s = { max: 1280, quality: 0.7, startQuality: 0.7 };
    const seen: number[] = [];
    for (let i = 0; i < 3; i++) {
      s = nextAttempt(s);
      assert.equal(s.max, 1280);
      seen.push(s.quality);
    }
    assert.deepEqual(seen, [0.6, 0.5, 0.4]);
  });
  it('reduit ensuite la taille de 15 % et repart de la qualite de depart', () => {
    const s = nextAttempt({ max: 1280, quality: 0.4, startQuality: 0.7 });
    assert.deepEqual(s, { max: 1088, quality: 0.7, startQuality: 0.7 });
  });
  it("s'arrete toujours (borne dure)", () => {
    let s: unknown = { max: 1280, quality: 0.7, startQuality: 0.7 };
    let n = 0;
    while (s && n < 1000) {
      s = nextAttempt(s);
      n++;
    }
    assert.equal(s, null);
    assert.ok(n < 60);
  });
});
