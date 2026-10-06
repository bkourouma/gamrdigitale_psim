import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterEach, describe, it } from 'node:test';
import { clearSessionCache, createSession, createUser, destroySession, destroyUserSessions, getSession, purgeExpired, setSessionValidator, useSessionStore } from '../server/auth.ts';
import { openDb } from '../server/db.ts';
import { createUsersService } from '../server/users.ts';

const T0 = 1_800_000_000_000;
const HOUR = 3_600_000;

function setup() {
  const db = openDb(':memory:');
  const clock = { t: T0 };
  const users = createUsersService({ db, key: Buffer.alloc(32, 5), now: () => clock.t, requireTotp: 'none', audit: () => {} });
  createUser(db, 'admin', 'admin', 'Mot-de-passe-admin-1', clock.t);
  setSessionValidator(users.validateSession);
  useSessionStore(db);
  const login = () => {
    const s = users.openSession('admin');
    return createSession('admin', s.role, s.epoch, s.restricted, clock.t);
  };
  /** Le PSIM redemarre : la memoire est perdue, la base reste. */
  const restart = () => clearSessionCache();
  return { db, clock, users, login, restart };
}

describe('sessions gardees au redemarrage', () => {
  afterEach(() => {
    useSessionStore(null);
    clearSessionCache();
  });

  it('une session ouverte reste valable apres un redemarrage du PSIM (pas de nouvelle connexion)', () => {
    const t = setup();
    const token = t.login();
    t.restart();
    const s = getSession(token, T0 + HOUR);
    assert.equal(s?.username, 'admin');
    assert.equal(s?.role, 'admin');
  });

  it('la base ne garde que l empreinte du jeton : une copie de la base ne permet pas de se connecter', () => {
    const t = setup();
    const token = t.login();
    const rows = t.db.prepare('SELECT * FROM app_session').all() as Record<string, unknown>[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0].token_hash, createHash('sha256').update(token).digest('hex'));
    assert.ok(!JSON.stringify(rows).includes(token), 'le jeton lui-meme n est nulle part en base');
    t.restart();
    assert.equal(getSession(rows[0].token_hash as string, T0), null, 'l empreinte presentee comme jeton est refusee');
  });

  it('mot de passe change pendant l arret : la session ne revient pas', () => {
    const t = setup();
    const token = t.login();
    t.restart();
    createUser(t.db, 'admin', 'admin', 'Un-autre-mot-de-passe-2', T0); // comme npm run set-password, PSIM arrete
    assert.equal(getSession(token, T0), null);
    assert.equal((t.db.prepare('SELECT COUNT(*) AS n FROM app_session').get() as { n: number }).n, 0, 'et elle est effacee de la base');
  });

  it('compte desactive ou supprime : plus de session, meme apres redemarrage', () => {
    const t = setup();
    const token = t.login();
    t.restart();
    t.db.prepare("UPDATE app_user SET active = 0 WHERE username = 'admin'").run();
    assert.equal(getSession(token, T0), null);
    const again = (() => {
      t.db.prepare("UPDATE app_user SET active = 1 WHERE username = 'admin'").run();
      return t.login();
    })();
    t.db.prepare("DELETE FROM app_user WHERE username = 'admin'").run();
    t.restart();
    assert.equal(getSession(again, T0), null);
  });

  it('expiree (12 h) : refusee et effacee, y compris par la purge periodique', () => {
    const t = setup();
    const a = t.login();
    t.restart();
    assert.equal(getSession(a, T0 + 13 * HOUR), null);
    const b = t.login();
    purgeExpired(T0 + 13 * HOUR);
    assert.equal((t.db.prepare('SELECT COUNT(*) AS n FROM app_session').get() as { n: number }).n, 0);
    t.restart();
    assert.equal(getSession(b, T0), null);
  });

  it('deconnexion, ou fermeture de toutes les sessions du compte : effacees de la base aussi', () => {
    const t = setup();
    const a = t.login();
    destroySession(a);
    const b = t.login();
    destroyUserSessions('admin');
    t.restart();
    assert.equal(getSession(a, T0), null);
    assert.equal(getSession(b, T0), null);
  });

  it('un jeton mal forme n interroge meme pas la base', () => {
    const t = setup();
    t.login();
    t.restart();
    assert.equal(getSession("x' OR 1=1 --", T0), null);
    assert.equal(getSession('', T0), null);
  });
});
