/**
 * Re-authentification (server/reauth.ts) : 428 sans mot de passe, 403 s'il est faux, 429 apres cinq essais faux par
 * minute, compteur PARTAGE avec la connexion (`user:<compte>`), fermeture des sessions au cinquieme echec, journal.
 * Chaque test prend son propre compte : le compteur d'echecs est global au processus.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { clearSessionCache, createSession, createUser, getSession, isRateLimited, recordFailure } from '../server/auth.ts';
import { openDb } from '../server/db.ts';
import { PsimError } from '../server/errors.ts';
import { reauthenticate } from '../server/reauth.ts';

const PW = 'Mot-de-passe-admin-solide-1';

function setup(name: string) {
  const db = openDb(':memory:');
  createUser(db, name, 'admin', PW);
  const journal: { actor: string; action: string; details?: string; deviceId?: string }[] = [];
  const audit = (actor: string, action: string, ref?: { details?: string; deviceId?: string }) => void journal.push({ actor, action, details: ref?.details, deviceId: ref?.deviceId });
  const run = (password: unknown, what = 'creer un compte') => reauthenticate(db, name, password, audit, { what });
  return { db, journal, run };
}
const statusOf = (fn: () => void): number => {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof PsimError, String(err));
    return err.status;
  }
  return 0;
};

describe('re-authentification', () => {
  afterEach(() => clearSessionCache());

  it('le bon mot de passe passe, sans rien inscrire au journal', () => {
    const t = setup('reauth-ok');
    assert.equal(statusOf(() => t.run(PW)), 0);
    assert.deepEqual(t.journal, []);
    assert.equal(isRateLimited('user:reauth-ok'), false);
  });

  it('mot de passe absent, vide ou non textuel : 428, et ce n est pas un echec compte', () => {
    const t = setup('reauth-absent');
    for (const v of [undefined, null, '', 42, { a: 1 }]) assert.equal(statusOf(() => t.run(v)), 428, JSON.stringify(v));
    assert.equal(isRateLimited('user:reauth-absent'), false);
    assert.deepEqual(t.journal, []);
  });

  it('mot de passe faux : 403 et entree reauth_echec au nom du compte, sans le mot de passe', () => {
    const t = setup('reauth-faux');
    assert.equal(statusOf(() => t.run('Pas-le-bon-mot-de-passe-9', 'creer un compte')), 403);
    assert.equal(t.journal.length, 1);
    assert.equal(t.journal[0].actor, 'reauth-faux');
    assert.equal(t.journal[0].action, 'reauth_echec');
    assert.match(t.journal[0].details ?? '', /creer un compte/);
    assert.ok(!JSON.stringify(t.journal).includes('Pas-le-bon-mot-de-passe-9'));
    assert.equal(statusOf(() => t.run('x'.repeat(201))), 403, 'mot de passe demesure : refuse sans calcul');
  });

  it('le nom du compte est compare sans tenir compte de la casse', () => {
    const t = setup('reauth-casse');
    assert.equal(statusOf(() => reauthenticate(t.db, 'Reauth-Casse', 'faux-faux-faux', () => {}, { what: 'test' })), 403);
    assert.equal(isRateLimited('user:reauth-casse'), false, 'un seul echec');
    recordFailure('user:reauth-casse');
    assert.equal(isRateLimited('user:reauth-casse'), false);
  });

  it('cinq mots de passe faux : sessions du compte fermees, puis 429 meme avec le bon mot de passe', () => {
    const t = setup('reauth-cinq');
    const token = createSession('reauth-cinq', 'admin', 0);
    const other = createSession('autre-compte', 'admin', 0);
    for (let i = 0; i < 4; i++) {
      assert.equal(statusOf(() => t.run('faux-faux-faux')), 403);
      assert.ok(getSession(token), `session encore ouverte apres ${i + 1} echec(s)`);
    }
    assert.equal(statusOf(() => t.run('faux-faux-faux')), 403, 'le cinquieme echec reste un 403');
    assert.equal(getSession(token), null, 'la session du compte est fermee');
    assert.ok(getSession(other), 'les sessions des autres comptes ne sont pas touchees');
    assert.equal(statusOf(() => t.run(PW)), 429, 'verrouille une minute, meme avec le bon mot de passe');
    const closed = t.journal.filter((e) => e.action === 'reauth_session_fermee');
    assert.equal(closed.length, 1);
    assert.equal(closed[0].actor, 'systeme');
    assert.match(closed[0].details ?? '', /reauth-cinq/);
    assert.equal(t.journal.filter((e) => e.action === 'reauth_echec').length, 5);
  });

  it('le compteur est celui de la connexion : trois echecs de connexion + deux de re-authentification = verrou', () => {
    const t = setup('reauth-partage');
    for (let i = 0; i < 3; i++) recordFailure('user:reauth-partage'); // ce que fait /api/login pour un mauvais mot de passe
    assert.equal(statusOf(() => t.run('faux-faux-faux')), 403);
    assert.equal(isRateLimited('user:reauth-partage'), false);
    assert.equal(statusOf(() => t.run('faux-faux-faux')), 403);
    assert.equal(isRateLimited('user:reauth-partage'), true, '3 + 2 = 5 : pas 5 + 5');
    assert.equal(statusOf(() => t.run(PW)), 429);
  });

  it('inversement : des echecs de re-authentification verrouillent la connexion du meme compte', () => {
    const t = setup('reauth-inverse');
    for (let i = 0; i < 5; i++) statusOf(() => t.run('faux-faux-faux'));
    assert.equal(isRateLimited('user:reauth-inverse'), true);
  });

  it('un compte deja verrouille est refuse en 429 sans nouvel echec ni nouveau journal', () => {
    const t = setup('reauth-deja');
    for (let i = 0; i < 5; i++) recordFailure('user:reauth-deja');
    assert.equal(statusOf(() => t.run('faux-faux-faux')), 429);
    assert.deepEqual(t.journal, []);
  });

  it('le journal peut porter un identifiant d equipement et une action personnalisee', () => {
    const t = setup('reauth-perso');
    const journal: { action: string; deviceId?: string }[] = [];
    assert.equal(statusOf(() => reauthenticate(t.db, 'reauth-perso', 'faux-faux-faux', (_a, action, ref) => void journal.push({ action, deviceId: ref?.deviceId }), { what: 'commande', failAction: 'commande_reauth_echec', deviceId: 'GACHE-1' })), 403);
    assert.deepEqual(journal, [{ action: 'commande_reauth_echec', deviceId: 'GACHE-1' }]);
  });
});
