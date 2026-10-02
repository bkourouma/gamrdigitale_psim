import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkCredentials, createSession, createUser, getSession, setSessionValidator } from '../server/auth.ts';
import { openDb } from '../server/db.ts';
import { PsimError } from '../server/engine.ts';
import { createUsersService } from '../server/users.ts';
import type { RequireTotp } from '../server/users.ts';
import { base32Decode, hashRecoveryCode, totp } from '../server/totp.ts';

const T0 = 1_800_000_000_000;
const KEY = Buffer.alloc(32, 5);
const ADMIN_PW = 'Mot-de-passe-admin-1';
const status = (code: number) => (e: unknown) => e instanceof PsimError && e.status === code;

function setup(requireTotp: RequireTotp = 'none') {
  const db = openDb(':memory:');
  const clock = { t: T0 };
  const audit: string[] = [];
  const users = createUsersService({ db, key: KEY, now: () => clock.t, requireTotp, audit: (actor, action, ref) => void audit.push(`${actor}:${action}${ref?.details ? `:${ref.details}` : ''}`) });
  createUser(db, 'admin', 'admin', ADMIN_PW, clock.t);
  setSessionValidator(users.validateSession);
  const login = (username: string) => {
    const s = users.openSession(username);
    return createSession(username, s.role, s.epoch, s.restricted, clock.t);
  };
  return { db, users, clock, audit, login };
}

const newUser = { username: 'Marie', role: 'operator', password: 'Un-bon-mot-de-passe-1', displayName: 'Marie Dupont' };

describe('creation de comptes', () => {
  it("normalise l'identifiant, impose le changement du mot de passe et journalise", () => {
    const t = setup();
    const u = t.users.create('admin', newUser);
    assert.equal(u.username, 'marie');
    assert.equal(u.mustChangePassword, true);
    assert.equal(u.displayName, 'Marie Dupont');
    assert.equal(u.active, true);
    assert.equal(checkCredentials(t.db, 'marie', newUser.password), 'operator');
    assert.ok(t.audit.includes('admin:user_created:marie (operator)'));
  });

  it('refuse un identifiant, un role ou un mot de passe invalides, et les doublons', () => {
    const t = setup();
    const bad = (over: Record<string, unknown>, code: number) => assert.throws(() => t.users.create('admin', { ...newUser, ...over }), status(code), JSON.stringify(over));
    bad({ username: 'ab' }, 400);
    bad({ username: 'a b c' }, 400);
    bad({ username: '../etc' }, 400);
    bad({ username: 'x'.repeat(40) }, 400);
    bad({ role: 'root' }, 400);
    bad({ password: 'court' }, 400);
    bad({ password: 'admin-dev-only' }, 400);
    bad({ password: 'marie-marie-marie' }, 400);
    bad({ displayName: 'x'.repeat(100) }, 400);
    t.users.create('admin', newUser);
    bad({ username: 'MARIE' }, 409);
    bad({ username: 'admin' }, 409);
    assert.equal(t.users.list().length, 2, 'rien de cree par les refus');
  });
});

describe('garde-fous : le dernier administrateur', () => {
  it('ne peut etre ni retrograde, ni desactive, ni supprime', () => {
    const t = setup();
    t.users.create('admin', { ...newUser, username: 'bob', role: 'operator' });
    assert.throws(() => t.users.update('bob', 'admin', { role: 'operator' }), status(409));
    assert.throws(() => t.users.update('bob', 'admin', { active: false }), status(409));
    assert.throws(() => t.users.remove('bob', 'admin'), status(409));
    assert.equal(t.users.get('admin').role, 'admin');
    assert.equal(t.users.get('admin').active, true);
  });

  it('devient possible des qu\'un second administrateur actif existe', () => {
    const t = setup();
    t.users.create('admin', { ...newUser, username: 'chef', role: 'admin' });
    assert.equal(t.users.update('chef', 'admin', { role: 'operator' }).role, 'operator');
    t.users.update('chef', 'chef', { role: 'admin' });
    t.users.update('chef', 'admin', { active: false });
    assert.equal(t.users.get('admin').active, false);
    assert.throws(() => t.users.update('chef', 'chef', { active: false }), status(409), 'pas son propre compte');
    assert.throws(() => t.users.remove('chef', 'chef'), status(409));
  });

  it('un administrateur desactive ne compte pas comme administrateur disponible', () => {
    const t = setup();
    t.users.create('admin', { ...newUser, username: 'chef', role: 'admin' });
    t.users.update('chef', 'admin', { active: false });
    assert.throws(() => t.users.update('admin', 'chef', { role: 'operator' }), status(409), 'chef est le dernier actif');
  });
});

describe('modification atomique', () => {
  it("si une modification demandee est refusee, aucune n'est appliquee", () => {
    const t = setup();
    t.users.create('admin', { ...newUser, username: 'chef', role: 'admin' });
    // chef tente de se retrograder ET de se desactiver : la seconde est refusee, la premiere ne doit pas rester appliquee.
    assert.throws(() => t.users.update('chef', 'chef', { role: 'operator', active: false, displayName: 'X' }), status(409));
    const u = t.users.get('chef');
    assert.equal(u.role, 'admin');
    assert.equal(u.active, true);
    assert.notEqual(u.displayName, 'X');
  });

  it('valide les valeurs avant tout', () => {
    const t = setup();
    t.users.create('admin', newUser);
    assert.throws(() => t.users.update('admin', 'marie', { role: 'root' }), status(400));
    assert.throws(() => t.users.update('admin', 'marie', { active: 'oui' }), status(400));
    assert.throws(() => t.users.update('admin', 'marie', { displayName: 'x'.repeat(100), role: 'admin' }), status(400));
    assert.equal(t.users.get('marie').role, 'operator');
  });
});

describe('sessions : tout changement les invalide immediatement', () => {
  it('desactiver un compte ferme sa session, et le reactiver ne la ressuscite pas', () => {
    const t = setup();
    t.users.create('admin', newUser);
    const token = t.login('marie');
    assert.equal(getSession(token, T0)?.username, 'marie');
    t.users.update('admin', 'marie', { active: false });
    assert.equal(getSession(token, T0), null);
    assert.equal(checkCredentials(t.db, 'marie', newUser.password), null, 'un compte desactive ne se connecte pas');
    t.users.update('admin', 'marie', { active: true });
    assert.equal(getSession(token, T0), null, 'ancienne session definitivement perdue');
    assert.equal(checkCredentials(t.db, 'marie', newUser.password), 'operator');
  });

  it("le role vient de la base a chaque requete : une promotion ou retrogradation est immediate", () => {
    const t = setup();
    t.users.create('admin', newUser);
    const token = t.login('marie');
    assert.equal(getSession(token, T0)?.role, 'operator');
    t.db.prepare("UPDATE app_user SET role = 'admin' WHERE username = 'marie'").run(); // modification directe de la base
    assert.equal(getSession(token, T0)?.role, 'admin');
  });

  it('un compte supprime perd sa session', () => {
    const t = setup();
    t.users.create('admin', newUser);
    const token = t.login('marie');
    t.users.remove('admin', 'marie');
    assert.equal(getSession(token, T0), null);
  });

  it("changer le role invalide les sessions du compte, et reinitialiser le mot de passe aussi", () => {
    const t = setup();
    t.users.create('admin', newUser);
    const a = t.login('marie');
    t.users.update('admin', 'marie', { role: 'admin' });
    assert.equal(getSession(a, T0), null);
    const b = t.login('marie');
    t.users.resetPassword('admin', 'marie', 'Nouveau-mot-de-passe-9');
    assert.equal(getSession(b, T0), null);
  });

  it("le CLI set-password (createUser) invalide aussi les sessions, sans perdre la 2FA", () => {
    const t = setup();
    const token = t.login('admin');
    createUser(t.db, 'admin', 'admin', 'Encore-un-autre-mot-de-passe-3');
    assert.equal(getSession(token, T0), null);
  });
});

describe('mots de passe', () => {
  it("la reinitialisation par l'administrateur exige un changement a la prochaine connexion", () => {
    const t = setup();
    t.users.create('admin', newUser);
    t.users.changeOwnPassword('marie', newUser.password, 'Mot-de-passe-perso-77');
    assert.equal(t.users.get('marie').mustChangePassword, false);
    t.users.resetPassword('admin', 'marie', 'Mot-de-passe-temporaire-5');
    assert.equal(t.users.get('marie').mustChangePassword, true);
    assert.equal(checkCredentials(t.db, 'marie', 'Mot-de-passe-perso-77'), null);
    assert.equal(checkCredentials(t.db, 'marie', 'Mot-de-passe-temporaire-5'), 'operator');
    assert.ok(t.audit.includes('admin:password_reset:marie'));
  });

  it("le changement personnel exige l'ancien mot de passe et un mot de passe different", () => {
    const t = setup();
    t.users.create('admin', newUser);
    assert.throws(() => t.users.changeOwnPassword('marie', 'faux', 'Mot-de-passe-perso-77'), status(403));
    assert.throws(() => t.users.changeOwnPassword('marie', newUser.password, newUser.password), status(400));
    assert.throws(() => t.users.changeOwnPassword('marie', newUser.password, 'court'), status(400));
    t.users.changeOwnPassword('marie', newUser.password, 'Mot-de-passe-perso-77');
    assert.equal(checkCredentials(t.db, 'marie', 'Mot-de-passe-perso-77'), 'operator');
    assert.equal(checkCredentials(t.db, 'marie', newUser.password), null);
  });
});

describe('restrictions de session', () => {
  it('un compte neuf est restreint au changement de mot de passe', () => {
    const t = setup();
    t.users.create('admin', newUser);
    assert.equal(t.users.openSession('marie').restricted, 'password');
    assert.equal(getSession(t.login('marie'), T0)?.restricted, 'password');
    t.users.changeOwnPassword('marie', newUser.password, 'Mot-de-passe-perso-77');
    assert.equal(t.users.openSession('marie').restricted, null);
  });

  it("la 2FA obligatoire pour les administrateurs restreint ceux qui ne l'ont pas encore activee", () => {
    const t = setup('admin');
    t.users.create('admin', newUser);
    t.users.changeOwnPassword('marie', newUser.password, 'Mot-de-passe-perso-77');
    assert.equal(t.users.openSession('admin').restricted, '2fa');
    assert.equal(t.users.openSession('marie').restricted, null, "l'operateur n'est pas concerne");
    const strict = setup('all');
    strict.users.create('admin', newUser);
    strict.users.changeOwnPassword('marie', newUser.password, 'Mot-de-passe-perso-77');
    assert.equal(strict.users.openSession('marie').restricted, '2fa');
  });

  it("la restriction suit la base : une session ouverte avant l'adoption de la regle est restreinte aussi", () => {
    const t = setup('none');
    const token = t.login('admin');
    assert.equal(getSession(token, T0)?.restricted, null);
    const stricter = createUsersService({ db: t.db, key: KEY, now: () => T0, requireTotp: 'admin', audit: () => {} });
    setSessionValidator(stricter.validateSession);
    assert.equal(getSession(token, T0)?.restricted, '2fa');
  });
});

/** Active la 2FA pour `username` et renvoie son secret et ses codes de secours. */
async function enroll(t: ReturnType<typeof setup>, username: string) {
  const begin = await t.users.beginTotp(username);
  const secret = base32Decode(begin.secret);
  const recovery = t.users.enableTotp(username, totp(secret, t.clock.t));
  return { begin, secret, recovery };
}

describe('double authentification (TOTP)', () => {
  it("l'activation exige un code valide, chiffre le secret et fournit 8 codes de secours", async () => {
    const t = setup();
    const begin = await t.users.beginTotp('admin');
    assert.match(begin.uri, /^otpauth:\/\/totp\//);
    assert.match(begin.qrSvg, /^<svg/);
    assert.throws(() => t.users.enableTotp('admin', '000000'), status(400));
    assert.equal(t.users.totpEnabled('admin'), false, 'un mauvais code n\'active rien');
    const codes = t.users.enableTotp('admin', totp(base32Decode(begin.secret), t.clock.t));
    assert.equal(codes.length, 8);
    assert.equal(t.users.totpEnabled('admin'), true);
    assert.equal(t.users.recoveryLeft('admin'), 8);
    const stored = (t.db.prepare("SELECT totp_secret FROM app_user WHERE username = 'admin'").get() as { totp_secret: string }).totp_secret;
    assert.ok(stored.startsWith('v1:') && !stored.includes(begin.secret), 'secret chiffre en base');
    await assert.rejects(t.users.beginTotp('admin'), status(409));
    assert.ok(t.audit.includes('admin:totp_enabled'));
  });

  it("refuse l'activation sans etape 1, ou apres expiration", async () => {
    const t = setup();
    assert.throws(() => t.users.enableTotp('admin', '123456'), status(400));
    const begin = await t.users.beginTotp('admin');
    t.clock.t += 11 * 60_000;
    assert.throws(() => t.users.enableTotp('admin', totp(base32Decode(begin.secret), t.clock.t)), status(400));
  });

  it('un defi accepte un code valide, jamais deux fois le meme (rejeu), puis la fenetre suivante', async () => {
    const t = setup();
    const { secret } = await enroll(t, 'admin');
    t.clock.t += 60_000; // l'activation a consomme la fenetre courante
    const code = totp(secret, t.clock.t);
    assert.equal(t.users.answerChallenge(t.users.createChallenge('admin'), code), 'admin');
    assert.equal(t.users.answerChallenge(t.users.createChallenge('admin'), code), null, 'rejeu refuse');
    t.clock.t += 30_000;
    assert.equal(t.users.answerChallenge(t.users.createChallenge('admin'), totp(secret, t.clock.t)), 'admin');
  });

  it("l'activation consomme sa propre fenetre : le code qui a servi a activer ne sert pas a se connecter", async () => {
    const t = setup();
    const { secret } = await enroll(t, 'admin');
    assert.equal(t.users.answerChallenge(t.users.createChallenge('admin'), totp(secret, t.clock.t)), null);
  });

  it('un defi expire au bout de 5 minutes et se ferme apres 5 essais rates', async () => {
    const t = setup();
    const { secret } = await enroll(t, 'admin');
    t.clock.t += 60_000;
    const expired = t.users.createChallenge('admin');
    t.clock.t += 6 * 60_000;
    assert.equal(t.users.answerChallenge(expired, totp(secret, t.clock.t)), null);

    const challenge = t.users.createChallenge('admin');
    for (let i = 0; i < 5; i++) assert.equal(t.users.answerChallenge(challenge, '000000'), null);
    assert.equal(t.users.answerChallenge(challenge, totp(secret, t.clock.t)), null, 'meme le bon code ne passe plus : defi detruit');
  });

  it('refuse un defi inconnu et un type de code invalide', async () => {
    const t = setup();
    await enroll(t, 'admin');
    assert.equal(t.users.answerChallenge('inconnu', '123456'), null);
    assert.equal(t.users.answerChallenge(t.users.createChallenge('admin'), 123456), null);
    assert.equal(t.users.answerChallenge(t.users.createChallenge('admin'), undefined), null);
  });
});

describe('defi : faute de frappe ou defi perdu', () => {
  it("une faute de frappe laisse reessayer (avec le nombre d'essais restants) ; l'epuisement ou l'expiration detruit le defi", async () => {
    const t = setup();
    const { secret } = await enroll(t, 'admin');
    t.clock.t += 60_000;
    const token = t.users.createChallenge('admin');
    assert.deepEqual(t.users.answerChallengeDetailed(token, '000000'), { error: 'wrong', attemptsLeft: 4 });
    assert.deepEqual(t.users.answerChallengeDetailed(token, '000000'), { error: 'wrong', attemptsLeft: 3 });
    assert.deepEqual(t.users.answerChallengeDetailed(token, totp(secret, t.clock.t)), { username: 'admin' }, 'le bon code passe apres des fautes');

    const exhausted = t.users.createChallenge('admin');
    for (let i = 0; i < 4; i++) t.users.answerChallengeDetailed(exhausted, '000000');
    assert.deepEqual(t.users.answerChallengeDetailed(exhausted, '000000'), { error: 'expired', attemptsLeft: 0 }, 'cinquieme echec : defi detruit');
    assert.deepEqual(t.users.answerChallengeDetailed(exhausted, totp(secret, t.clock.t + 30_000)), { error: 'expired', attemptsLeft: 0 });

    const old = t.users.createChallenge('admin');
    t.clock.t += 6 * 60_000;
    assert.deepEqual(t.users.answerChallengeDetailed(old, '123456'), { error: 'expired', attemptsLeft: 0 });
    assert.deepEqual(t.users.answerChallengeDetailed('inconnu', '123456'), { error: 'expired', attemptsLeft: 0 });
  });
});

describe('codes de secours', () => {
  it('chacun sert une seule fois, sans tenir compte de la casse', async () => {
    const t = setup();
    const { recovery } = await enroll(t, 'admin');
    const code = recovery[0];
    assert.equal(t.users.answerChallenge(t.users.createChallenge('admin'), code.toUpperCase()), 'admin');
    assert.equal(t.users.recoveryLeft('admin'), 7);
    assert.equal(t.users.answerChallenge(t.users.createChallenge('admin'), code), null, 'deja utilise');
    assert.equal(t.users.answerChallenge(t.users.createChallenge('admin'), recovery[1]), 'admin');
    assert.ok(t.audit.includes('admin:recovery_code_used'));
  });

  it("seules les empreintes sont en base, et la regeneration invalide les anciens codes", async () => {
    const t = setup();
    const { recovery } = await enroll(t, 'admin');
    const hashes = (t.db.prepare('SELECT hash FROM recovery_code').all() as { hash: string }[]).map((r) => r.hash);
    assert.ok(!hashes.includes(recovery[0]) && hashes.includes(hashRecoveryCode(recovery[0])));
    assert.throws(() => t.users.regenerateRecovery('admin', 'mauvais'), status(403));
    const fresh = t.users.regenerateRecovery('admin', ADMIN_PW);
    assert.equal(fresh.length, 8);
    assert.equal(t.users.answerChallenge(t.users.createChallenge('admin'), recovery[0]), null, 'ancien code mort');
    assert.equal(t.users.answerChallenge(t.users.createChallenge('admin'), fresh[0]), 'admin');
  });
});

describe('desactivation et reinitialisation de la 2FA', () => {
  it("l'utilisateur la desactive avec son mot de passe, sauf si le role l'impose", async () => {
    const t = setup();
    await enroll(t, 'admin');
    assert.throws(() => t.users.disableTotp('admin', 'faux'), status(403));
    t.users.disableTotp('admin', ADMIN_PW);
    assert.equal(t.users.totpEnabled('admin'), false);
    assert.equal(t.users.recoveryLeft('admin'), 0);

    const strict = setup('admin');
    await enroll(strict, 'admin');
    assert.throws(() => strict.users.disableTotp('admin', ADMIN_PW), status(409));
  });

  it("l'administrateur la reinitialise pour un telephone perdu : sessions fermees, 2FA retiree", async () => {
    const t = setup();
    t.users.create('admin', newUser);
    await enroll(t, 'marie');
    const token = t.login('marie');
    const view = t.users.adminResetTotp('admin', 'marie');
    assert.equal(view.totpEnabled, false);
    assert.equal(getSession(token, T0), null);
    assert.equal(t.users.recoveryLeft('marie'), 0);
    assert.ok(t.audit.includes('admin:totp_reset:marie'));
  });

  it('supprimer un compte supprime aussi ses codes de secours', async () => {
    const t = setup();
    t.users.create('admin', newUser);
    await enroll(t, 'marie');
    t.users.remove('admin', 'marie');
    assert.equal((t.db.prepare("SELECT COUNT(*) AS n FROM recovery_code WHERE username = 'marie'").get() as { n: number }).n, 0);
  });
});

describe('comptes existants (migration)', () => {
  it("une base de la premiere version est migree : comptes conserves, actifs, sans 2FA", () => {
    const db = openDb(':memory:');
    db.exec("INSERT INTO app_user (username, role, salt, hash) VALUES ('ancien', 'operator', 'aa', 'bb')");
    const users = createUsersService({ db, key: KEY, audit: () => {} });
    const u = users.get('ancien');
    assert.equal(u.active, true);
    assert.equal(u.totpEnabled, false);
    assert.equal(u.mustChangePassword, false);
  });
});
