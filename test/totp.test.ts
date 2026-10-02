import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { base32Decode, base32Encode, hashRecoveryCode, hotp, newRecoveryCodes, newSecret, normalizeRecoveryCode, otpauthUri, stepOf, totp, verifyTotp } from '../server/totp.ts';

// Secret ASCII "12345678901234567890" : celui des vecteurs de test de la RFC 4226 / 6238.
const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');

describe('TOTP : conformite aux vecteurs officiels', () => {
  it('HOTP (RFC 4226, annexe D) : les 10 premiers codes', () => {
    const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
    assert.deepEqual(expected.map((_, counter) => hotp(RFC_SECRET, counter)), expected);
  });

  it('TOTP (RFC 6238, annexe B, SHA-1, 8 chiffres)', () => {
    const vectors: [number, string][] = [
      [59, '94287082'],
      [1111111109, '07081804'],
      [1111111111, '14050471'],
      [1234567890, '89005924'],
      [2000000000, '69279037'],
      [20000000000, '65353130'],
    ];
    for (const [seconds, code] of vectors) assert.equal(totp(RFC_SECRET, seconds * 1000, 8), code, `t=${seconds}`);
  });

  it('les codes a 6 chiffres sont les 6 derniers du code a 8 chiffres', () => {
    assert.equal(totp(RFC_SECRET, 59_000, 6), '287082');
  });
});

describe('verification', () => {
  const secret = newSecret();
  const T = 1_800_000_000_000;

  it('accepte le code courant et la tolerance de +-1 fenetre, refuse au-dela', () => {
    const step = stepOf(T);
    assert.equal(verifyTotp(secret, totp(secret, T), T), step);
    assert.equal(verifyTotp(secret, totp(secret, T - 30_000), T), step - 1, 'telephone en retard de 30 s');
    assert.equal(verifyTotp(secret, totp(secret, T + 30_000), T), step + 1, 'telephone en avance de 30 s');
    assert.equal(verifyTotp(secret, totp(secret, T - 90_000), T), null);
    assert.equal(verifyTotp(secret, totp(secret, T + 90_000), T), null);
  });

  it('renvoie la fenetre trouvee, ce qui permet de refuser le rejeu', () => {
    const step = verifyTotp(secret, totp(secret, T), T)!;
    const lastUsed = step;
    assert.ok(!(verifyTotp(secret, totp(secret, T), T)! > lastUsed), 'le meme code ne passe pas deux fois');
  });

  it('refuse un format invalide sans lever d\'exception, tolere les espaces', () => {
    for (const bad of ['', '12345', '1234567', 'abcdef', '12 345', '١٢٣٤٥٦']) assert.equal(verifyTotp(secret, bad, T), null, JSON.stringify(bad));
    const code = totp(secret, T);
    assert.notEqual(verifyTotp(secret, `${code.slice(0, 3)} ${code.slice(3)}`, T), null, 'saisie « 123 456 » acceptee');
  });

  it('un autre secret ne passe pas', () => {
    assert.equal(verifyTotp(newSecret(), totp(secret, T), T), null);
  });
});

describe('base32 et URI', () => {
  it('encode et decode (vecteurs RFC 4648)', () => {
    assert.equal(base32Encode(Buffer.from('foobar')), 'MZXW6YTBOI');
    assert.equal(base32Decode('MZXW6YTBOI').toString(), 'foobar');
    assert.equal(base32Decode('mzxw 6ytb-oi').toString(), 'foobar', 'tolere minuscules, espaces et tirets');
    assert.throws(() => base32Decode('MZXW1'), /invalide/);
  });

  it('un secret fait l\'aller-retour', () => {
    const s = newSecret();
    assert.equal(s.length, 20);
    assert.deepEqual(base32Decode(base32Encode(s)), s);
    assert.notDeepEqual(newSecret(), newSecret());
  });

  it("l'URI otpauth contient tout ce que l'application a besoin", () => {
    const uri = otpauthUri({ secret: RFC_SECRET, account: 'operateur', issuer: 'GAMRdigitale PSIM' });
    assert.match(uri, /^otpauth:\/\/totp\/GAMRdigitale%20PSIM:operateur\?/);
    assert.match(uri, /secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ/);
    assert.match(uri, /issuer=GAMRdigitale%20PSIM/);
    assert.match(uri, /period=30/);
    assert.match(uri, /digits=6/);
  });
});

describe('codes de secours', () => {
  it('huit codes distincts de la forme abcd-efgh, sans caracteres ambigus', () => {
    const codes = newRecoveryCodes();
    assert.equal(codes.length, 8);
    assert.equal(new Set(codes).size, 8);
    for (const c of codes) assert.match(c, /^[a-hj-km-np-z2-9]{4}-[a-hj-km-np-z2-9]{4}$/);
  });

  it("l'empreinte ignore la casse et les espaces, et differe d'un code a l'autre", () => {
    const [a, b] = newRecoveryCodes(2);
    assert.equal(hashRecoveryCode(a), hashRecoveryCode(` ${a.toUpperCase()} `));
    assert.notEqual(hashRecoveryCode(a), hashRecoveryCode(b));
    assert.equal(normalizeRecoveryCode(' ABCD-EFGH '), 'abcd-efgh');
    assert.match(hashRecoveryCode(a), /^[0-9a-f]{64}$/);
  });
});
