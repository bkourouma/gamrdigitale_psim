import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';
import { resetTwoFactor } from '../scripts/reset-2fa.ts';
import { isKnownLoginIp, isRateLimited, purgeExpired, recordFailure, rememberLoginIp, validatePassword, createSession, createUser, getSession } from '../server/auth.ts';
import { verify } from '../server/auditchain.ts';
import { openDb } from '../server/db.ts';
import { seal, unseal } from '../server/secrets.ts';
import { createUsersService } from '../server/users.ts';
import { base32Decode, totp } from '../server/totp.ts';

const T0 = 1_800_000_000_000;
const KEY = Buffer.alloc(32, 9);

function setup() {
  const db = openDb(':memory:');
  const clock = { t: T0 };
  const audit: string[] = [];
  const users = createUsersService({ db, key: KEY, now: () => clock.t, requireTotp: 'none', audit: (actor, action) => void audit.push(`${actor}:${action}`) });
  createUser(db, 'admin', 'admin', 'Mot-de-passe-admin-1', clock.t);
  createUser(db, 'paul', 'operator', 'Mot-de-passe-operateur-2', clock.t);
  return { db, users, clock, audit };
}
async function enroll(t: ReturnType<typeof setup>, username: string) {
  const begin = await t.users.beginTotp(username);
  const secret = base32Decode(begin.secret);
  t.users.enableTotp(username, totp(secret, t.clock.t));
  return secret;
}

describe('chiffrement des secrets : etiquette GCM de 16 octets exactement', () => {
  it("un secret intact se dechiffre ; une etiquette tronquee ou alteree est refusee", () => {
    const sealed = seal(KEY, 'secret-totp-123');
    assert.equal(unseal(KEY, sealed), 'secret-totp-123');
    const [v, iv, tag, data] = sealed.split(':');
    const short = [v, iv, Buffer.from(tag, 'base64').subarray(0, 4).toString('base64'), data].join(':');
    assert.throws(() => unseal(KEY, short), /etiquette invalide|altere/, 'etiquette de 4 octets : falsifiable, donc refusee');
    const flipped = Buffer.from(tag, 'base64');
    flipped[0] ^= 1;
    assert.throws(() => unseal(KEY, [v, iv, flipped.toString('base64'), data].join(':')));
    assert.throws(() => unseal(Buffer.alloc(32, 1), sealed), 'mauvaise cle');
  });

  it("un secret scelle avec une etiquette courte par un tiers n'est pas accepte meme avec la bonne cle", () => {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', KEY, iv, { authTagLength: 4 });
    const data = Buffer.concat([cipher.update('pirate', 'utf8'), cipher.final()]);
    const forged = ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
    assert.throws(() => unseal(KEY, forged));
  });
});

describe('mots de passe : liste des plus courants', () => {
  it("refuse les mots courants (seuls ou repetes), les chiffres seuls ; accepte une vraie phrase de passe", () => {
    for (const p of ['passwordpassword', 'Password-Password', 'azertyazertyazerty', 'qwertyuiop1234', '123456789012', 'administrateur12', 'motdepassemotdepasse', 'changemechangeme']) {
      assert.ok(validatePassword(p, 'jean'), `${p} doit etre refuse`);
    }
    for (const p of ['Girafe-orange-77-soleil-X', 'Mot-de-passe-admin-solide-1', 'correct horse battery staple', 'Un-vrai-mot-de-passe-1']) {
      assert.equal(validatePassword(p, 'jean'), null, `${p} doit passer`);
    }
  });
});

describe('limiteurs et memoire', () => {
  it("limite configurable (nombre et fenetre) ; purge des cles anciennes", () => {
    const now = Date.now();
    for (let i = 0; i < 9; i++) recordFailure('sec:test', now, 10 * 60_000);
    assert.equal(isRateLimited('sec:test', now, 10, 10 * 60_000), false);
    recordFailure('sec:test', now, 10 * 60_000);
    assert.equal(isRateLimited('sec:test', now, 10, 10 * 60_000), true);
    assert.equal(isRateLimited('sec:test', now + 11 * 60_000, 10, 10 * 60_000), false, 'la fenetre expire');
    for (let i = 0; i < 50; i++) recordFailure(`sec:attaquant-${i}`, now);
    purgeExpired(now + 11 * 60_000);
    assert.equal(isRateLimited('sec:attaquant-1', now + 11 * 60_000), false);
  });

  it("purge les sessions expirees sans toucher aux sessions valables", () => {
    const old = createSession('paul', 'operator', 0, null, Date.now() - 13 * 3600_000);
    const fresh = createSession('paul', 'operator', 0, null, Date.now());
    purgeExpired(Date.now());
    assert.equal(getSession(old), null);
    assert.ok(getSession(fresh));
  });

  it("adresses connues d'un compte : memorisees, bornees (20 au plus)", () => {
    for (let i = 0; i < 30; i++) rememberLoginIp('sec-user', `10.0.0.${i}`);
    assert.equal(isKnownLoginIp('sec-user', '10.0.0.29'), true);
    assert.equal(isKnownLoginIp('sec-user', '10.0.0.0'), false, 'la plus ancienne a ete oubliee');
    assert.equal(isKnownLoginIp('sec-user', '192.168.0.1'), false);
    assert.equal(isKnownLoginIp('inconnu', '10.0.0.29'), false);
  });
});

describe('defi 2FA', () => {
  it("lie a la version des identifiants : un mot de passe change pendant l'attente le rend inutilisable", async () => {
    const t = setup();
    const secret = await enroll(t, 'paul');
    t.clock.t += 60_000;
    const challenge = t.users.createChallenge('paul');
    assert.equal(t.users.challengeOwner(challenge), 'paul');
    createUser(t.db, 'paul', 'operator', 'Nouveau-mot-de-passe-3', t.clock.t); // l'epoch change
    assert.deepEqual(t.users.answerChallengeDetailed(challenge, totp(secret, t.clock.t)), { error: 'expired', attemptsLeft: 0 });
    assert.equal(t.users.challengeOwner(challenge), null, 'le defi est detruit');
  });

  it("un compte desactive pendant l'attente ne peut pas finir sa connexion", async () => {
    const t = setup();
    const secret = await enroll(t, 'paul');
    t.clock.t += 60_000;
    const challenge = t.users.createChallenge('paul');
    t.users.update('admin', 'paul', { active: false });
    assert.equal('username' in t.users.answerChallengeDetailed(challenge, totp(secret, t.clock.t)), false);
  });

  it("sans changement, le bon code ouvre toujours la connexion ; un defi expire n'a plus de proprietaire", async () => {
    const t = setup();
    const secret = await enroll(t, 'paul');
    t.clock.t += 60_000;
    const challenge = t.users.createChallenge('paul');
    assert.deepEqual(t.users.answerChallengeDetailed(challenge, totp(secret, t.clock.t)), { username: 'paul' });
    const old = t.users.createChallenge('paul');
    t.clock.t += 6 * 60_000;
    assert.equal(t.users.challengeOwner(old), null);
    assert.equal(t.users.challengeOwner('inconnu'), null);
  });
});

describe('cle de chiffrement perdue ou changee', () => {
  it("le code TOTP est refuse proprement (pas d'erreur 500), les codes de secours fonctionnent, et le probleme est signale", async () => {
    const t = setup();
    const begin = await t.users.beginTotp('paul');
    const secret = base32Decode(begin.secret);
    const recovery = t.users.enableTotp('paul', totp(secret, t.clock.t));
    // restauration sur une autre machine : meme base, AUTRE cle
    const other = createUsersService({ db: t.db, key: Buffer.alloc(32, 77), now: () => t.clock.t, requireTotp: 'none', audit: () => {} });
    assert.deepEqual(other.unreadableSecrets(), ['paul']);
    assert.deepEqual(t.users.unreadableSecrets(), [], 'avec la bonne cle : rien a signaler');
    t.clock.t += 60_000;
    const c1 = other.createChallenge('paul');
    assert.deepEqual(other.answerChallengeDetailed(c1, totp(secret, t.clock.t)), { error: 'wrong', attemptsLeft: 4 }, 'refuse, sans exception');
    const c2 = other.createChallenge('paul');
    assert.deepEqual(other.answerChallengeDetailed(c2, recovery[0]), { username: 'paul' }, 'le code de secours ouvre la connexion');
  });
});

describe('npm run reset-2fa (recours depuis la machine)', () => {
  it("retire la 2FA et les codes de secours, ferme les sessions, et journalise « console » dans la chaine scellee", async () => {
    const t = setup();
    await enroll(t, 'paul');
    const before = t.db.prepare("SELECT session_epoch FROM app_user WHERE username = 'paul'").get() as { session_epoch: number };
    assert.equal(t.users.totpEnabled('paul'), true);
    assert.equal(resetTwoFactor(t.db, 'paul', T0), true);
    assert.equal(t.users.totpEnabled('paul'), false);
    assert.equal((t.db.prepare("SELECT COUNT(*) AS n FROM recovery_code WHERE username = 'paul'").get() as { n: number }).n, 0);
    assert.equal((t.db.prepare("SELECT session_epoch FROM app_user WHERE username = 'paul'").get() as { session_epoch: number }).session_epoch, before.session_epoch + 1, 'sessions invalidees');
    const entry = t.db.prepare("SELECT actor, action, details FROM audit_log ORDER BY id DESC LIMIT 1").get() as { actor: string; action: string; details: string };
    assert.deepEqual({ ...entry }, { actor: 'console', action: 'totp_reset', details: 'paul' });
    assert.equal(verify(t.db).ok, true, 'la chaine du journal reste valide');
  });

  it("compte sans 2FA : sessions fermees quand meme ; compte inconnu : faux", () => {
    const t = setup();
    assert.equal(resetTwoFactor(t.db, 'paul', T0), false);
    assert.equal(resetTwoFactor(t.db, 'fantome', T0), false);
  });
});
