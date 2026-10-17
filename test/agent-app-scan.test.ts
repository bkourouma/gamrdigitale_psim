/** Application agent : lecture d'une etiquette (calculs purs de web/agent/scan.js). */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
// @ts-expect-error module JS de l'interface (sans types), importe pour tester ses calculs purs
import { nfcSupported, parseCheckpointCode, qrSupported } from '../web/agent/scan.js';

describe('application agent : parseCheckpointCode', () => {
  it('accepte une URL complete, un fragment, cp= et un code brut', () => {
    assert.equal(parseCheckpointCode('https://psim.example/agent/#cp=abcde23456'), 'abcde23456');
    assert.equal(parseCheckpointCode('https://192.168.1.5:3043/agent/#cp=abcde23456'), 'abcde23456');
    assert.equal(parseCheckpointCode('#cp=abcde23456'), 'abcde23456');
    assert.equal(parseCheckpointCode('cp=abcde23456'), 'abcde23456');
    assert.equal(parseCheckpointCode('abcde23456'), 'abcde23456');
  });

  it('tolere majuscules, espaces et tirets', () => {
    assert.equal(parseCheckpointCode('ABCDE23456'), 'abcde23456');
    assert.equal(parseCheckpointCode('  ABCDE 23456 '), 'abcde23456');
    assert.equal(parseCheckpointCode('abcde-23456'), 'abcde23456');
    assert.equal(parseCheckpointCode('https://h/agent/#cp=ABCDE23456'), 'abcde23456');
  });

  it('rejette tout le reste', () => {
    assert.equal(parseCheckpointCode(''), null);
    assert.equal(parseCheckpointCode('   '), null);
    assert.equal(parseCheckpointCode(null), null);
    assert.equal(parseCheckpointCode(undefined), null);
    assert.equal(parseCheckpointCode(42), null);
    assert.equal(parseCheckpointCode('abcde2345'), null); // 9 caracteres
    assert.equal(parseCheckpointCode('abcde234567'), null); // 11 caracteres
    assert.equal(parseCheckpointCode('abcde11111'), null); // 1 hors alphabet base32
    assert.equal(parseCheckpointCode('abcde0189!'), null);
    assert.equal(parseCheckpointCode('https://h/agent/#pair=abcde23456'), null);
    assert.equal(parseCheckpointCode('#pair=abcde23456'), null);
    assert.equal(parseCheckpointCode('https://example.com/'), null);
    assert.equal(parseCheckpointCode('https://h/agent/#cp=abcde2345'), null);
  });
});

describe('application agent : detection des capacites', () => {
  it('ne leve pas en Node et suit globalThis', () => {
    assert.equal(nfcSupported(), false);
    assert.equal(qrSupported(), false);
    const g = globalThis as Record<string, unknown>;
    g.NDEFReader = class {};
    g.BarcodeDetector = class {};
    try {
      assert.equal(nfcSupported(), true);
      assert.equal(qrSupported(), true);
    } finally {
      delete g.NDEFReader;
      delete g.BarcodeDetector;
    }
  });
});
