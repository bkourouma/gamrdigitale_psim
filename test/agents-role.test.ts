import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, it } from 'node:test';
import {
  checkCredentials,
  clearSessionCache,
  createSession,
  createUser,
  destroyPhoneSessions,
  getSession,
  setSessionValidator,
  useSessionStore,
} from '../server/auth.ts';
import { migrateAgentRole, openDb } from '../server/db.ts';
import { PsimError, createEngine } from '../server/engine.ts';
import { createNotifier } from '../server/notifications.ts';
import type { Channel, Message } from '../server/notifications.ts';
import { ALWAYS_ACTIVE_EVENTS, EVENTS, EVENT_LABEL, eventLabel, eventLabelPlain, interpret } from '../server/sources.ts';
import type { SensorSettings } from '../server/sources.ts';
import { createUsersService } from '../server/users.ts';
import type { RequireTotp } from '../server/users.ts';
import { ADMIN_ONLY_DETAILS, maskAudit } from '../server/visibility.ts';
import type { AuditEntry } from '../server/types.ts';

const T0 = 1_800_000_000_000;
const MIN = 60_000;
const HOUR = 3_600_000;
const KEY = Buffer.alloc(32, 5);
const status = (code: number) => (e: unknown) => e instanceof PsimError && e.status === code;

// ------------------------------------------------------------------ migration du role agent

const OLD_USER_SQL = `CREATE TABLE app_user (
  username TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('operator', 'admin')),
  salt TEXT NOT NULL,
  hash TEXT NOT NULL,
  display_name TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER,
  last_login_at INTEGER,
  password_changed_at INTEGER,
  session_epoch INTEGER NOT NULL DEFAULT 0,
  totp_secret TEXT,
  totp_enabled_at INTEGER,
  totp_last_step INTEGER
)`;

/** Base creee AVANT le role agent : l'ancienne table app_user (CHECK operator/admin), garnie, avec ses deux tables liees. */
function writeOldDatabase(path: string, userSql = OLD_USER_SQL, seed = true): void {
  const old = new DatabaseSync(path);
  old.exec('PRAGMA foreign_keys = ON');
  old.exec(userSql);
  old.exec(`CREATE TABLE recovery_code (
    username TEXT NOT NULL REFERENCES app_user(username) ON DELETE CASCADE,
    hash TEXT NOT NULL,
    used_at INTEGER,
    PRIMARY KEY (username, hash)
  )`);
  old.exec(`CREATE TABLE app_session (
    token_hash TEXT PRIMARY KEY,
    username TEXT NOT NULL REFERENCES app_user(username) ON DELETE CASCADE ON UPDATE CASCADE,
    role TEXT NOT NULL,
    expires INTEGER NOT NULL,
    epoch INTEGER NOT NULL,
    restricted TEXT
  )`);
  if (!seed) {
    old.close();
    return;
  }
  old
    .prepare(
      `INSERT INTO app_user (username, role, salt, hash, display_name, active, must_change_password, created_at, last_login_at, password_changed_at, session_epoch, totp_secret, totp_enabled_at, totp_last_step)
       VALUES ('admin', 'admin', 'sel-a', 'hash-a', 'Administrateur', 1, 0, 111, 222, 333, 3, 'secret-chiffre', 444, 555)`,
    )
    .run();
  old
    .prepare(`INSERT INTO app_user (username, role, salt, hash, display_name, active, must_change_password, session_epoch) VALUES ('marie', 'operator', 'sel-m', 'hash-m', NULL, 0, 1, 7)`)
    .run();
  const code = old.prepare('INSERT INTO recovery_code (username, hash, used_at) VALUES (?, ?, ?)');
  code.run('admin', 'c1', null);
  code.run('admin', 'c2', 999);
  code.run('marie', 'c3', null);
  const session = old.prepare('INSERT INTO app_session (token_hash, username, role, expires, epoch, restricted) VALUES (?, ?, ?, ?, ?, ?)');
  session.run('t1', 'admin', 'admin', T0 + HOUR, 3, null);
  session.run('t2', 'marie', 'operator', T0 + HOUR, 7, 'password');
  old.close();
}

const count = (db: DatabaseSync, table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const foreignKeys = (db: DatabaseSync) => (db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys;
const userSql = (db: DatabaseSync) => (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'app_user'").get() as { sql: string }).sql;

describe('migration du role agent (migrateAgentRole)', () => {
  const dirs: string[] = [];
  const tempFile = () => {
    const dir = mkdtempSync(join(tmpdir(), 'psim-agentrole-'));
    dirs.push(dir);
    return join(dir, 'psim.db');
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("une base ancienne : les trois tables gardent leurs lignes, le role agent passe, un second openDb est sans effet", () => {
    const path = tempFile();
    writeOldDatabase(path);
    const db = openDb(path);
    try {
      assert.ok(userSql(db).includes("'agent'"), 'le CHECK accepte agent');
      assert.equal(count(db, 'app_user'), 2);
      assert.equal(count(db, 'recovery_code'), 3, 'codes de secours conserves (pas de CASCADE a la recreation)');
      assert.equal(count(db, 'app_session'), 2, 'sessions conservees');
      // Toutes les colonnes sont recopiees a l'identique.
      assert.deepEqual(
        { ...(db.prepare("SELECT * FROM app_user WHERE username = 'admin'").get() as Record<string, unknown>) },
        { username: 'admin', role: 'admin', salt: 'sel-a', hash: 'hash-a', display_name: 'Administrateur', active: 1, must_change_password: 0, created_at: 111, last_login_at: 222, password_changed_at: 333, session_epoch: 3, totp_secret: 'secret-chiffre', totp_enabled_at: 444, totp_last_step: 555 },
      );
      assert.deepEqual(
        { ...(db.prepare("SELECT * FROM app_user WHERE username = 'marie'").get() as Record<string, unknown>) },
        { username: 'marie', role: 'operator', salt: 'sel-m', hash: 'hash-m', display_name: null, active: 0, must_change_password: 1, created_at: null, last_login_at: null, password_changed_at: null, session_epoch: 7, totp_secret: null, totp_enabled_at: null, totp_last_step: null },
      );
      assert.deepEqual(
        db.prepare('SELECT username, hash, used_at FROM recovery_code ORDER BY hash').all().map((r) => ({ ...r })),
        [{ username: 'admin', hash: 'c1', used_at: null }, { username: 'admin', hash: 'c2', used_at: 999 }, { username: 'marie', hash: 'c3', used_at: null }],
      );
      assert.deepEqual(
        db.prepare('SELECT token_hash, username, role, restricted, phone_id FROM app_session ORDER BY token_hash').all().map((r) => ({ ...r })),
        [{ token_hash: 't1', username: 'admin', role: 'admin', restricted: null, phone_id: null }, { token_hash: 't2', username: 'marie', role: 'operator', restricted: 'password', phone_id: null }],
      );
      assert.equal(foreignKeys(db), 1, 'cles etrangeres remises en route');
      assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
      // Un agent est desormais accepte ; un role inconnu reste refuse.
      db.prepare("INSERT INTO app_user (username, role, salt, hash) VALUES ('agent.un', 'agent', 's', 'h')").run();
      assert.throws(() => db.prepare("INSERT INTO app_user (username, role, salt, hash) VALUES ('x', 'root', 's', 'h')").run(), /CHECK|constraint/i);
      // Les cles etrangeres des tables liees visent toujours app_user, et le CASCADE fonctionne.
      assert.throws(() => db.prepare("INSERT INTO app_session (token_hash, username, role, expires, epoch) VALUES ('t9', 'inconnu', 'admin', 1, 0)").run(), /FOREIGN KEY/i);
      db.prepare("DELETE FROM app_user WHERE username = 'marie'").run();
      assert.equal(count(db, 'app_session'), 1);
      assert.equal(count(db, 'recovery_code'), 2);
    } finally {
      db.close();
    }

    // Deuxieme ouverture : rien ne change.
    const again = openDb(path);
    try {
      assert.equal(count(again, 'app_user'), 2, 'admin + agent.un (marie supprimee plus haut)');
      assert.equal(count(again, 'app_session'), 1);
      assert.equal(count(again, 'recovery_code'), 2);
      assert.equal(again.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'app_user%'").get()?.n, 1, 'pas de table app_user_v2 oubliee');
      const sqlBefore = userSql(again);
      migrateAgentRole(again);
      assert.equal(userSql(again), sqlBefore, 'idempotente');
      assert.equal(foreignKeys(again), 1);
    } finally {
      again.close();
    }
  });

  it("une base tres ancienne (app_user a quatre colonnes) : les colonnes ajoutees par migrate sont recopiees aussi", () => {
    const path = tempFile();
    writeOldDatabase(
      path,
      `CREATE TABLE app_user (username TEXT PRIMARY KEY, role TEXT NOT NULL CHECK (role IN ('operator', 'admin')), salt TEXT NOT NULL, hash TEXT NOT NULL)`,
      false,
    );
    // Seules les 4 colonnes d'origine existent : on les remplit a la main.
    const raw = new DatabaseSync(path);
    raw.exec('PRAGMA foreign_keys = ON');
    raw.exec("INSERT INTO app_user VALUES ('admin', 'admin', 'sel', 'hash'); INSERT INTO app_session VALUES ('t1', 'admin', 'admin', 1, 0, NULL); INSERT INTO recovery_code VALUES ('admin', 'c1', NULL)");
    raw.close();
    const db = openDb(path);
    try {
      assert.ok(userSql(db).includes("'agent'"));
      const admin = db.prepare("SELECT * FROM app_user WHERE username = 'admin'").get() as Record<string, unknown>;
      assert.equal(admin.hash, 'hash');
      assert.equal(admin.active, 1, 'valeur par defaut de la colonne ajoutee');
      assert.equal(admin.session_epoch, 0);
      assert.equal(count(db, 'app_session'), 1);
      assert.equal(count(db, 'recovery_code'), 1);
    } finally {
      db.close();
    }
  });

  it("une base neuve accepte le role agent d'emblee, sans recreation", () => {
    const db = openDb(':memory:');
    assert.ok(userSql(db).includes("'agent'"));
    db.prepare("INSERT INTO app_user (username, role, salt, hash) VALUES ('a1', 'agent', 's', 'h')").run();
    assert.equal(foreignKeys(db), 1);
    // Colonnes ajoutees : telephone d'une session, precision d'un incident.
    assert.ok((db.prepare('PRAGMA table_info(app_session)').all() as { name: string }[]).some((c) => c.name === 'phone_id'));
    assert.ok((db.prepare('PRAGMA table_info(incident)').all() as { name: string }[]).some((c) => c.name === 'detail'));
    db.close();
  });

  it("un echec en cours de route annule tout et remet les cles etrangeres", () => {
    // Base ancienne avec une table app_user_v2 qui gene : la creation echoue au milieu de la procedure.
    const path2 = tempFile();
    writeOldDatabase(path2);
    const raw = new DatabaseSync(path2, { timeout: 5000 });
    raw.exec('PRAGMA foreign_keys = ON');
    raw.exec('CREATE TABLE app_user_v2 (x INTEGER)');
    // Colonnes ajoutees a la main (ce que migrate() fait avant migrateAgentRole dans openDb).
    raw.exec('ALTER TABLE app_session ADD COLUMN phone_id INTEGER');
    assert.throws(() => migrateAgentRole(raw), /app_user_v2|already exists/i);
    assert.equal(foreignKeys(raw), 1, 'remises meme apres une erreur');
    assert.equal(count(raw, 'app_user'), 2);
    assert.equal(count(raw, 'app_session'), 2);
    assert.equal(count(raw, 'recovery_code'), 3);
    assert.ok(!userSql(raw).includes("'agent'"), 'table d\'origine intacte');
    assert.equal(raw.prepare('PRAGMA foreign_key_check').all().length, 0);
    // Aucune transaction restee ouverte.
    raw.exec('BEGIN');
    raw.exec('ROLLBACK');
    raw.close();
  });

  it("une violation de cle etrangere ANTERIEURE a la migration ne la bloque pas", () => {
    const path = tempFile();
    writeOldDatabase(path);
    const raw = new DatabaseSync(path);
    raw.exec('PRAGMA foreign_keys = OFF');
    raw.exec("INSERT INTO app_session (token_hash, username, role, expires, epoch) VALUES ('orphelin', 'fantome', 'admin', 1, 0)");
    raw.close();
    const db = openDb(path);
    try {
      assert.ok(userSql(db).includes("'agent'"));
      assert.equal(count(db, 'app_session'), 3, 'la ligne orpheline est conservee telle quelle');
    } finally {
      db.close();
    }
  });
});

// ------------------------------------------------------------------ comptes

function setupUsers(requireTotp: RequireTotp = 'none') {
  const db = openDb(':memory:');
  const clock = { t: T0 };
  const audit: string[] = [];
  const users = createUsersService({
    db,
    key: KEY,
    now: () => clock.t,
    requireTotp,
    audit: (actor, action, ref) => void audit.push(`${actor}:${action}${ref?.details ? `:${ref.details}` : ''}`),
  });
  createUser(db, 'admin', 'admin', 'Mot-de-passe-admin-1', clock.t);
  return { db, users, clock, audit };
}

describe('comptes agents (users.ts)', () => {
  afterEach(() => {
    setSessionValidator(null);
    useSessionStore(null);
    clearSessionCache();
  });

  it("createAgentAccount : compte actif de role agent, mot de passe aleatoire inutilisable, sans audit ni changement a faire", () => {
    const t = setupUsers();
    const u = t.users.createAgentAccount('admin', 'Agent.Un', '  Moussa Camara ');
    assert.equal(u.username, 'agent.un', 'identifiant normalise comme create()');
    assert.equal(u.role, 'agent');
    assert.equal(u.displayName, 'Moussa Camara');
    assert.equal(u.active, true);
    assert.equal(u.mustChangePassword, false);
    assert.equal(u.totpEnabled, false);
    assert.equal(u.createdAt, T0);
    assert.deepEqual(t.audit, [], "aucune entree d'audit : agents.ts journalisera agent_created");
    assert.equal(t.users.restrictionFor('agent.un'), null, 'aucune etape a accomplir');
    // Aucun mot de passe courant ne convient (le vrai, 64 caracteres hexadecimaux aleatoires, n\'est communique a personne).
    for (const guess of ['', 'agent.un', 'Agent.Un', 'admin-dev-only', '0'.repeat(64), 'Mot-de-passe-admin-1']) assert.equal(checkCredentials(t.db, 'agent.un', guess), null, guess);
    // Deux agents n'ont pas le meme mot de passe.
    t.users.createAgentAccount('admin', 'agent.deux', 'Awa');
    const rows = t.db.prepare("SELECT hash, salt FROM app_user WHERE role = 'agent' ORDER BY username").all() as { hash: string; salt: string }[];
    assert.equal(rows.length, 2);
    assert.notEqual(rows[0].hash, rows[1].hash);
    assert.notEqual(rows[0].salt, rows[1].salt);
  });

  it('createAgentAccount : identifiant invalide ou deja pris, nom invalide : refus sans rien creer', () => {
    const t = setupUsers();
    for (const bad of ['ab', 'a b c', '../etc', 'x'.repeat(40), '', 'Ecole!']) assert.throws(() => t.users.createAgentAccount('admin', bad, 'Nom'), status(400), bad);
    assert.throws(() => t.users.createAgentAccount('admin', 'agent.ok', 'x'.repeat(100)), status(400), 'nom trop long');
    assert.throws(() => t.users.createAgentAccount('admin', 'agent.ok', 'Nom\u0007'), status(400), 'caractere de controle');
    assert.equal(t.users.list().length, 1, 'rien de cree par les refus');
    t.users.createAgentAccount('admin', 'agent.ok', 'Nom');
    assert.throws(() => t.users.createAgentAccount('admin', 'AGENT.OK', 'Autre'), status(409));
    assert.throws(() => t.users.createAgentAccount('admin', 'admin', 'Autre'), status(409), "ne reprend jamais le compte d'un autre");
    assert.equal(t.users.get('admin').role, 'admin', "l'administrateur n'a pas ete modifie");
    assert.equal(checkCredentials(t.db, 'admin', 'Mot-de-passe-admin-1'), 'admin');
  });

  it("les agents figurent dans list()", () => {
    const t = setupUsers();
    t.users.createAgentAccount('admin', 'agent.un', 'Moussa');
    assert.deepEqual(t.users.list().map((u) => `${u.username}:${u.role}`), ['admin:admin', 'agent.un:agent']);
  });

  it("create() refuse le role agent (400) en renvoyant vers l'ecran Rondes", () => {
    const t = setupUsers();
    assert.throws(
      () => t.users.create('admin', { username: 'agent.un', role: 'agent', password: 'Un-bon-mot-de-passe-1', displayName: 'X' }),
      (e: unknown) => e instanceof PsimError && e.status === 400 && /Rondes/.test(e.message),
    );
    assert.equal(t.users.list().length, 1);
    // Les autres roles fonctionnent toujours ; un role inconnu reste une erreur 400 ordinaire.
    assert.throws(() => t.users.create('admin', { username: 'marie', role: 'root', password: 'Un-bon-mot-de-passe-1' }), status(400));
    assert.equal(t.users.create('admin', { username: 'marie', role: 'operator', password: 'Un-bon-mot-de-passe-1' }).role, 'operator');
  });

  it("update() : on ne passe pas un compte a agent ni ne retire le role agent (409), mais statut et nom restent modifiables", () => {
    const t = setupUsers();
    t.users.create('admin', { username: 'marie', role: 'operator', password: 'Un-bon-mot-de-passe-1' });
    t.users.createAgentAccount('admin', 'agent.un', 'Moussa');
    assert.throws(() => t.users.update('admin', 'marie', { role: 'agent' }), status(409));
    assert.throws(() => t.users.update('admin', 'admin', { role: 'agent' }), status(409));
    assert.throws(() => t.users.update('admin', 'agent.un', { role: 'operator' }), status(409));
    assert.throws(() => t.users.update('admin', 'agent.un', { role: 'admin' }), status(409));
    assert.throws(() => t.users.update('admin', 'agent.un', { role: 'root' }), status(400));
    // Tout ou rien : un refus de role n'applique pas non plus le reste de la demande.
    assert.throws(() => t.users.update('admin', 'agent.un', { role: 'operator', displayName: 'Change', active: false }), status(409));
    assert.equal(t.users.get('agent.un').displayName, 'Moussa');
    assert.equal(t.users.get('agent.un').active, true);
    assert.equal(t.users.get('marie').role, 'operator');
    // Repeter le role actuel d'un agent n'est pas un changement.
    assert.equal(t.users.update('admin', 'agent.un', { role: 'agent', displayName: 'Moussa C.' }).displayName, 'Moussa C.');
    // Desactiver puis reactiver un agent, depuis l'ecran des comptes.
    assert.equal(t.users.update('admin', 'agent.un', { active: false }).active, false);
    assert.equal(t.users.update('admin', 'agent.un', { active: true }).active, true);
    assert.equal(t.users.get('agent.un').role, 'agent');
  });

  it("resetPassword et changeOwnPassword refusent un compte agent (409) ; l'inconnu reste 404", () => {
    const t = setupUsers();
    t.users.createAgentAccount('admin', 'agent.un', 'Moussa');
    const hashBefore = (t.db.prepare("SELECT hash FROM app_user WHERE username = 'agent.un'").get() as { hash: string }).hash;
    assert.throws(() => t.users.resetPassword('admin', 'agent.un', 'Un-bon-mot-de-passe-9'), status(409));
    assert.throws(() => t.users.changeOwnPassword('agent.un', 'peu-importe', 'Un-bon-mot-de-passe-9'), status(409));
    assert.throws(() => t.users.resetPassword('admin', 'fantome', 'Un-bon-mot-de-passe-9'), status(404));
    assert.equal((t.db.prepare("SELECT hash FROM app_user WHERE username = 'agent.un'").get() as { hash: string }).hash, hashBefore, 'mot de passe inchange');
    assert.equal(t.users.get('agent.un').mustChangePassword, false);
    // Les autres comptes ne sont pas concernes.
    assert.equal(t.users.resetPassword('admin', 'admin', 'Un-bon-mot-de-passe-9').mustChangePassword, true);
  });

  it("needsTotp('agent') = false : meme avec la 2FA exigee de tous, un agent n'a aucune etape ; les autres roles en gardent une", () => {
    for (const mode of ['none', 'admin', 'all'] as const) {
      const t = setupUsers(mode);
      t.users.createAgentAccount('admin', 'agent.un', 'Moussa');
      t.users.create('admin', { username: 'marie', role: 'operator', password: 'Un-bon-mot-de-passe-1' });
      const opened = t.users.openSession('agent.un');
      assert.equal(opened.role, 'agent');
      assert.equal(opened.restricted, null, `agent, 2FA ${mode}`);
      assert.equal(t.users.restrictionFor('agent.un'), null);
      // Pour comparaison : l'administrateur doit activer la 2FA en mode admin/all, l'operateur en mode all (apres changement de mot de passe).
      assert.equal(t.users.restrictionFor('admin'), mode === 'none' ? null : '2fa');
      assert.equal(t.users.restrictionFor('marie'), 'password');
    }
  });
});

// ------------------------------------------------------------------ sessions d'agent

describe('sessions : duree propre et telephone', () => {
  afterEach(() => {
    setSessionValidator(null);
    useSessionStore(null);
    clearSessionCache();
  });

  function setupSessions() {
    const t = setupUsers();
    t.users.createAgentAccount('admin', 'agent.un', 'Moussa');
    t.users.createAgentAccount('admin', 'agent.deux', 'Awa');
    setSessionValidator(t.users.validateSession);
    useSessionStore(t.db);
    const epoch = (u: string) => t.users.openSession(u).epoch;
    return { ...t, epoch };
  }

  it('sans options : 12 h et pas de telephone, comme avant', () => {
    const t = setupSessions();
    const token = createSession('admin', 'admin', t.epoch('admin'), null, T0);
    assert.equal(getSession(token, T0 + 12 * HOUR)?.username, 'admin');
    assert.equal(getSession(token, T0 + 12 * HOUR + 1), null);
    const again = createSession('admin', 'admin', t.epoch('admin'), null, T0);
    const s = getSession(again, T0 + 1);
    assert.ok(s);
    assert.ok(!('phoneId' in s) || s.phoneId == null);
    assert.equal((t.db.prepare('SELECT phone_id FROM app_session WHERE username = ? LIMIT 1').get('admin') as { phone_id: number | null }).phone_id, null);
    clearSessionCache();
    const reloaded = getSession(again, T0 + 1);
    assert.ok(reloaded && !reloaded.phoneId, 'relue en base : toujours sans telephone');
  });

  it("ttlMs et phoneId : la session expire a l'heure voulue et survit a un redemarrage (relue en base)", () => {
    const t = setupSessions();
    const token = createSession('agent.un', 'agent', t.epoch('agent.un'), null, T0, { ttlMs: 30 * MIN, phoneId: 7 });
    const row = t.db.prepare('SELECT phone_id, expires, role FROM app_session').get() as { phone_id: number; expires: number; role: string };
    assert.deepEqual({ ...row }, { phone_id: 7, expires: T0 + 30 * MIN, role: 'agent' });
    const live = getSession(token, T0 + 29 * MIN);
    assert.equal(live?.username, 'agent.un');
    assert.equal(live?.role, 'agent');
    assert.equal(live?.phoneId, 7);
    // Redemarrage du PSIM : la memoire est perdue, la base garde le telephone et l'echeance.
    clearSessionCache();
    const restored = getSession(token, T0 + 30 * MIN);
    assert.equal(restored?.phoneId, 7, "derniere milliseconde de validite");
    assert.equal(restored?.role, 'agent');
    clearSessionCache();
    assert.equal(getSession(token, T0 + 30 * MIN + 1), null, "expiree a l'heure voulue (30 min, et non 12 h)");
    assert.equal(count(t.db, 'app_session'), 0, 'ligne oubliee a l expiration');
  });

  it("ttlMs plus long que 12 h : respecte (service de 16 h)", () => {
    const t = setupSessions();
    const token = createSession('agent.un', 'agent', t.epoch('agent.un'), null, T0, { ttlMs: 16 * HOUR, phoneId: 1 });
    assert.ok(getSession(token, T0 + 13 * HOUR));
    assert.ok(getSession(token, T0 + 16 * HOUR));
    assert.equal(getSession(token, T0 + 16 * HOUR + 1), null);
  });

  it("phoneId null ou absent : session sans telephone ; ttlMs seul ne pose pas de telephone", () => {
    const t = setupSessions();
    const a = createSession('agent.un', 'agent', t.epoch('agent.un'), null, T0, { ttlMs: MIN });
    const b = createSession('agent.un', 'agent', t.epoch('agent.un'), null, T0, { phoneId: null });
    assert.ok(!getSession(a, T0)?.phoneId);
    assert.ok(!getSession(b, T0)?.phoneId);
    assert.equal(count(t.db, 'app_session'), 2);
    assert.equal((t.db.prepare('SELECT COUNT(*) AS n FROM app_session WHERE phone_id IS NULL').get() as { n: number }).n, 2);
    assert.equal(getSession(a, T0 + MIN + 1), null);
    assert.ok(getSession(b, T0 + MIN + 1), 'b garde la duree par defaut');
  });

  it("destroyPhoneSessions : ferme seulement les sessions de ce telephone, en memoire et en base", () => {
    const t = setupSessions();
    const ep1 = t.epoch('agent.un');
    const ep2 = t.epoch('agent.deux');
    const p7a = createSession('agent.un', 'agent', ep1, null, T0, { phoneId: 7 });
    const p7b = createSession('agent.deux', 'agent', ep2, null, T0, { phoneId: 7 });
    const p8 = createSession('agent.un', 'agent', ep1, null, T0, { phoneId: 8 });
    const admin = createSession('admin', 'admin', t.epoch('admin'), null, T0);
    assert.equal(destroyPhoneSessions(7), 2);
    assert.equal(getSession(p7a, T0 + 1), null);
    assert.equal(getSession(p7b, T0 + 1), null);
    assert.equal(getSession(p8, T0 + 1)?.phoneId, 8);
    assert.ok(getSession(admin, T0 + 1), 'une session ordinaire ne depend d\'aucun telephone');
    assert.equal(count(t.db, 'app_session'), 2, 'lignes du telephone 7 supprimees en base');
    assert.equal((t.db.prepare('SELECT COUNT(*) AS n FROM app_session WHERE phone_id = 7').get() as { n: number }).n, 0);
    assert.equal(destroyPhoneSessions(7), 0, 'idempotent');
    assert.equal(destroyPhoneSessions(999), 0, 'telephone inconnu : sans effet');
    assert.ok(getSession(p8, T0 + 2));
  });

  it("destroyPhoneSessions agit aussi sur les sessions connues de la seule base (apres redemarrage)", () => {
    const t = setupSessions();
    const token = createSession('agent.un', 'agent', t.epoch('agent.un'), null, T0, { phoneId: 3 });
    clearSessionCache();
    assert.equal(destroyPhoneSessions(3), 0, 'rien en memoire');
    assert.equal(getSession(token, T0 + 1), null, 'mais la base a ete videe : le jeton ne revient pas');
    assert.equal(count(t.db, 'app_session'), 0);
  });

  it("une session d'agent perd sa validite si le compte est desactive (controle de la base a chaque requete)", () => {
    const t = setupSessions();
    const token = createSession('agent.un', 'agent', t.epoch('agent.un'), null, T0, { phoneId: 7 });
    assert.ok(getSession(token, T0 + 1));
    t.users.update('admin', 'agent.un', { active: false });
    assert.equal(getSession(token, T0 + 2), null);
  });
});

// ------------------------------------------------------------------ evenements et lecture d'un message

const settings = (category: SensorSettings['category'] = 'people'): SensorSettings => ({ category, warnAt: null, alarmAt: null, direction: 'above' });
const ok = (r: ReturnType<typeof interpret>) => {
  assert.equal(r.ok, true, JSON.stringify(r));
  return r as Extract<ReturnType<typeof interpret>, { ok: true }>;
};
const err = (r: ReturnType<typeof interpret>) => {
  assert.equal(r.ok, false, JSON.stringify(r));
  return (r as { ok: false; error: string }).error;
};

describe('evenements des rondes (sources.ts)', () => {
  it('patrol_incomplete, patrol_missed et logbook_report : effet et libelle', () => {
    assert.equal(EVENTS.patrol_incomplete, 'prealarm');
    assert.equal(EVENTS.patrol_missed, 'alarm');
    assert.equal(EVENTS.logbook_report, 'prealarm');
    assert.equal(EVENT_LABEL.patrol_incomplete, 'Ronde incomplète');
    assert.equal(EVENT_LABEL.patrol_missed, 'Ronde non faite');
    assert.equal(EVENT_LABEL.logbook_report, "Signalement d'un agent");
    assert.equal(eventLabelPlain('patrol_incomplete'), 'Ronde incomplete');
    assert.equal(eventLabelPlain('logbook_report'), "Signalement d'un agent");
    assert.equal(eventLabel('patrol_missed'), 'Ronde non faite');
    // L'appel de detresse existe deja et reste une alarme toujours active.
    assert.equal(EVENTS.sos, 'alarm');
    assert.equal(EVENT_LABEL.sos, 'Appel de détresse (SOS)');
  });

  it('toujours actifs : les rondes ratees et le SOS, pas le signalement', () => {
    assert.ok(ALWAYS_ACTIVE_EVENTS.has('patrol_incomplete'));
    assert.ok(ALWAYS_ACTIVE_EVENTS.has('patrol_missed'));
    assert.ok(ALWAYS_ACTIVE_EVENTS.has('sos'));
    assert.ok(!ALWAYS_ACTIVE_EVENTS.has('logbook_report'));
    for (const old of ['tamper', 'panic', 'fall']) assert.ok(ALWAYS_ACTIVE_EVENTS.has(old), `${old} reste actif`);
  });

  it('chaque evenement de la liste a un libelle (y compris les nouveaux)', () => {
    for (const event of Object.keys(EVENTS)) assert.ok(EVENT_LABEL[event], `libelle de ${event}`);
    for (const event of Object.keys(EVENT_LABEL)) assert.ok(Object.hasOwn(EVENTS, event), `${event} a un libelle mais n'est pas un evenement`);
  });

  it('les evenements interpretes donnent le bon etat', () => {
    assert.deepEqual(ok(interpret(settings(), { event: 'patrol_missed' })), { ok: true, state: 'alarm', event: 'patrol_missed', alive: false, value: null, detail: null });
    assert.equal(ok(interpret(settings(), { event: 'patrol_incomplete' })).state, 'prealarm');
    assert.equal(ok(interpret(settings(), { event: 'logbook_report' })).state, 'prealarm');
  });

  it("ces trois evenements sont aussi reconnus par un equipement d'une autre categorie (liste fermee unique)", () => {
    for (const category of ['fire', 'intrusion', 'access', 'environment', 'energy', 'people'] as const) {
      assert.equal(ok(interpret(settings(category), { event: 'patrol_missed' })).state, 'alarm');
    }
  });
});

describe("champ detail d'un message (interpret)", () => {
  it('absent ou null : detail vaut null', () => {
    assert.equal(ok(interpret(settings(), { event: 'sos' })).detail, null);
    assert.equal(ok(interpret(settings(), { event: 'sos', detail: null })).detail, null);
    assert.equal(ok(interpret(settings(), { state: 'alarm' })).detail, null);
    assert.equal(ok(interpret(settings(), { value: 3 })).detail, null);
  });

  it('un texte valide est conserve, rogne, avec tous les types de message', () => {
    const detail = '3 points manques : Parking, Arriere-cour, Local bouteilles';
    assert.equal(ok(interpret(settings(), { event: 'patrol_missed', detail })).detail, detail);
    assert.equal(ok(interpret(settings(), { event: 'patrol_missed', detail: `  ${detail}\t ` })).detail, detail, 'rogne');
    assert.equal(ok(interpret(settings(), { state: 'alarm', detail })).detail, detail);
    assert.equal(ok(interpret(settings(), { value: 1, detail })).detail, detail);
    assert.equal(ok(interpret(settings(), { event: 'heartbeat', detail })).detail, detail, 'un signe de vie peut en porter un');
    assert.equal(ok(interpret(settings(), { event: 'sos', detail: 'Agent Moussa : dernier point « Hall », il y a 2 min' })).detail, 'Agent Moussa : dernier point « Hall », il y a 2 min', 'accents et guillemets acceptes');
    // Forme Unicode unique (NFC) : e + accent combinant devient un seul caractere.
    assert.equal(ok(interpret(settings(), { event: 'sos', detail: 'Réception' })).detail, 'Réception');
  });

  it('valeurs limites : 1 caractere accepte, 300 acceptes, 301 refuses, vide refuse', () => {
    assert.equal(ok(interpret(settings(), { event: 'sos', detail: 'x' })).detail, 'x');
    assert.equal(ok(interpret(settings(), { event: 'sos', detail: 'x'.repeat(300) })).detail?.length, 300);
    assert.match(err(interpret(settings(), { event: 'sos', detail: 'x'.repeat(301) })), /^detail invalide/);
    assert.match(err(interpret(settings(), { event: 'sos', detail: '' })), /^detail invalide/);
    assert.match(err(interpret(settings(), { event: 'sos', detail: '   \t ' })), /^detail invalide/, 'que des blancs : vide apres rognage');
    // La longueur se compte apres rognage.
    assert.equal(ok(interpret(settings(), { event: 'sos', detail: ` ${'x'.repeat(300)} ` })).detail?.length, 300);
    assert.match(err(interpret(settings(), { event: 'sos', detail: ` ${'x'.repeat(301)} ` })), /^detail invalide/);
  });

  it('caracteres interdits : controles, saut de ligne, format invisible', () => {
    for (const bad of ['a\nb', 'a\rb', 'a\tb', 'a\u0000b', 'a\u001bb', 'a\u007fb', 'a\u0085b', 'a b', 'a b', 'a​b', 'a‮b', 'a﻿b']) {
      assert.match(err(interpret(settings(), { event: 'sos', detail: bad })), /^detail invalide/, JSON.stringify(bad));
    }
  });

  it("types inattendus : nombre, booleen, objet, tableau refuses (jamais d'exception)", () => {
    for (const bad of [0, 12, true, false, {}, [], ['a'], { toString: 'x' }]) {
      assert.match(err(interpret(settings(), { event: 'sos', detail: bad })), /^detail invalide/, JSON.stringify(bad));
    }
  });

  it('un detail invalide refuse tout le message, meme si le reste est valide', () => {
    assert.match(err(interpret(settings(), { event: 'patrol_missed', detail: 'a\nb', value: 3 })), /^detail invalide/);
    assert.match(err(interpret(settings(), { state: 'alarm', detail: 42 })), /^detail invalide/);
    // Et un message deja invalide garde son propre message d'erreur (le detail n'est pas la premiere cause).
    assert.equal(err(interpret(settings(), { event: 'inconnu', detail: 'ok' })), 'event inconnu');
    assert.equal(err(interpret(settings(), { detail: 'seul' })), 'state, event ou value requis');
  });

  it('le message de refus ne recopie pas le texte envoye', () => {
    assert.ok(!err(interpret(settings(), { event: 'sos', detail: 'SECRET\u0001' })).includes('SECRET'));
  });
});

// ------------------------------------------------------------------ audit

describe('journal : actions des agents reservees a l\'administrateur', () => {
  it('les sept actions sensibles sont masquees aux operateurs', () => {
    const actions = ['agent_phone_created', 'agent_phone_paired', 'agent_phone_revoked', 'agent_login_failed', 'agent_locked', 'agent_unlocked', 'patrol_history_read'];
    for (const action of actions) {
      assert.ok(ADMIN_ONLY_DETAILS.has(action), action);
      const entry: AuditEntry = { id: 1, ts: T0, actor: 'admin', action, incidentId: null, deviceId: null, details: 'telephone 3 « Poste nord »' };
      assert.equal(maskAudit(entry, 'operator').details, null, `${action} masque pour un operateur`);
      assert.equal(maskAudit(entry, 'admin').details, entry.details, `${action} visible de l'administrateur`);
    }
  });

  it('les autres actions des agents (service, SOS, rondes) restent lisibles par un operateur', () => {
    for (const action of ['agent_created', 'agent_login', 'agent_shift_started', 'agent_shift_ended', 'agent_dispatch', 'sos_sent', 'patrol_run_closed']) {
      assert.ok(!ADMIN_ONLY_DETAILS.has(action), action);
    }
  });
});

// ------------------------------------------------------------------ moteur et notifications

function setupEngine() {
  const db = openDb(':memory:');
  const clock = { t: T0 };
  const engine = createEngine(db, () => {}, () => clock.t);
  const sent: Message[] = [];
  const channel: Channel = {
    id: 'chat',
    label: 'chat',
    recipients: (level) => (level === 1 ? ['a'] : []),
    mask: (r) => r,
    async send(message) {
      sent.push(message);
    },
  };
  const notifier = createNotifier({ db, engine, channels: [channel], now: () => clock.t, escalateAfterMs: 180_000, reminderMs: 300_000, maxReminders: 2, retryDelaysMs: [0] });
  engine.createDevice('admin', { id: 'P-1', kind: 'detector', category: 'people', name: 'Ronde de nuit', zone: 'Parking', heartbeatS: 0 });
  engine.createDevice('admin', { id: 'P-2', kind: 'detector', category: 'people', name: 'Ronde du matin', zone: 'Hall', heartbeatS: 0 });
  const openIncident = (detectorId: string) => engine.getSnapshot().incidents.find((i) => i.detectorId === detectorId && i.status !== 'closed');
  return { db, engine, notifier, sent, clock, openIncident };
}

describe('le detail traverse le moteur et les notifications', () => {
  it("patrol_missed + detail sur un detecteur de la categorie personnes : incident critique qui porte le detail", async () => {
    const t = setupEngine();
    const detail = '3 points manques : Parking, Arriere-cour, Local bouteilles';
    t.engine.handleDetectorMessage('P-1', { event: 'patrol_missed', detail });
    const incident = t.openIncident('P-1');
    assert.ok(incident, 'incident ouvert');
    assert.equal(incident.severity, 'critical');
    assert.equal(incident.event, 'patrol_missed');
    assert.equal(incident.category, 'people');
    assert.equal(incident.detail, detail);
    assert.equal(t.engine.incidentView(incident.id).detail, detail);
    assert.equal((t.db.prepare('SELECT detail FROM incident WHERE id = ?').get(incident.id) as { detail: string }).detail, detail);
    assert.equal(t.engine.getSnapshot().incidents.find((i) => i.id === incident.id)?.detail, detail, "l'instantane du poste de garde le porte aussi");

    await t.notifier.notifyIncident(t.engine.incidentView(incident.id), 'opened');
    assert.equal(t.sent.length, 1);
    const lines = t.sent[0].text.split('\n');
    assert.ok(lines.includes(`Detail : ${detail}`), `ligne Detail presente : ${t.sent[0].text}`);
    const zone = lines.findIndex((l) => l.startsWith('Zone : '));
    assert.equal(lines[zone + 1], `Detail : ${detail}`, 'juste apres la ligne Zone');
    assert.equal(t.sent[0].data?.detail, detail);
    assert.match(t.sent[0].subject, /ALARME PERSONNES : Ronde non faite - a confirmer - Ronde de nuit/);
  });

  it("sans detail : incident.detail vaut null, aucune ligne Detail et pas de cle detail dans les donnees", async () => {
    const t = setupEngine();
    t.engine.handleDetectorMessage('P-1', { event: 'patrol_missed' });
    const incident = t.openIncident('P-1');
    assert.ok(incident);
    assert.equal(incident.detail, null);
    assert.equal(t.engine.incidentView(incident.id).detail, null);
    await t.notifier.notifyIncident(t.engine.incidentView(incident.id), 'opened');
    assert.ok(!/Detail/.test(t.sent[0].text));
    assert.ok(!('detail' in (t.sent[0].data ?? {})), 'donnees inchangees : pas de cle detail');
  });

  it("un incident cree par un message {state} sans evenement garde aussi le detail ; un message invalide ouvre rien (400)", () => {
    const t = setupEngine();
    t.engine.handleDetectorMessage('P-1', { state: 'alarm', detail: 'etat porte par un detail' });
    assert.equal(t.openIncident('P-1')?.detail, 'etat porte par un detail');
    const refused = t.engine.ingest('P-2', { event: 'patrol_missed', detail: 'a\nb' });
    assert.deepEqual(refused, { ok: false, status: 400, error: refused.ok ? '' : refused.error });
    assert.match(refused.ok ? '' : refused.error, /^detail invalide/);
    assert.equal(t.openIncident('P-2'), undefined, 'rien ouvert');
    assert.equal(t.engine.getDevice('P-2')?.status, 'normal');
  });

  it("escalade : patrol_incomplete puis patrol_missed -> le nouveau detail remplace l'ancien ; sans nouveau detail l'ancien est garde", () => {
    const t = setupEngine();
    t.engine.handleDetectorMessage('P-1', { event: 'patrol_incomplete', detail: '2 points manques : A, B' });
    let incident = t.openIncident('P-1');
    assert.equal(incident?.severity, 'warning');
    assert.equal(incident?.detail, '2 points manques : A, B');
    t.clock.t += MIN;
    t.engine.handleDetectorMessage('P-1', { event: 'patrol_missed', detail: '1 point manque : B' });
    incident = t.openIncident('P-1');
    assert.equal(incident?.severity, 'critical');
    assert.equal(incident?.event, 'patrol_missed');
    assert.equal(incident?.detail, '1 point manque : B');

    // Meme escalade sans detail dans le second message : le premier reste.
    t.engine.handleDetectorMessage('P-2', { event: 'patrol_incomplete', detail: 'ronde du matin : C manque' });
    t.clock.t += MIN;
    t.engine.handleDetectorMessage('P-2', { event: 'patrol_missed' });
    const second = t.openIncident('P-2');
    assert.equal(second?.severity, 'critical');
    assert.equal(second?.detail, 'ronde du matin : C manque');
  });

  it("un incident deja critique n'est pas modifie par un second message (comme avant)", () => {
    const t = setupEngine();
    t.engine.handleDetectorMessage('P-1', { event: 'patrol_missed', detail: 'premier' });
    t.clock.t += MIN;
    t.engine.handleDetectorMessage('P-1', { event: 'patrol_missed', detail: 'second' });
    assert.equal(t.openIncident('P-1')?.detail, 'premier');
  });

  it("alarme datee plus ancienne que l'etat connu (renvoi apres coupure) : l'incident ouvert a sa date porte le detail", () => {
    const t = setupEngine();
    t.engine.handleDetectorMessage('P-1', { event: 'clear', ts: T0 });
    t.clock.t += 10 * MIN;
    t.engine.handleDetectorMessage('P-1', { event: 'patrol_missed', detail: 'renvoye apres une coupure', ts: T0 - 5 * MIN });
    const incident = t.openIncident('P-1');
    assert.ok(incident, 'alarme passee conservee');
    assert.equal(incident.openedAt, T0 - 5 * MIN);
    assert.equal(incident.detail, 'renvoye apres une coupure');
    assert.ok((incident.receivedLateMs ?? 0) > 0);
  });

  it("alarme datee plus ancienne rattachee a un incident warning en cours : l'escalade porte le detail", () => {
    const t = setupEngine();
    t.engine.handleDetectorMessage('P-1', { event: 'patrol_incomplete', detail: 'incomplete', ts: T0 });
    t.clock.t += 10 * MIN;
    t.engine.handleDetectorMessage('P-1', { event: 'patrol_missed', detail: 'ratee, en retard', ts: T0 - MIN });
    const incident = t.openIncident('P-1');
    assert.equal(incident?.severity, 'critical');
    assert.equal(incident?.detail, 'ratee, en retard');
  });

  it("les rondes ratees sont toujours actives : une zone d'intrusion desarmee ne les masque pas (categorie intrusion)", () => {
    const db = openDb(':memory:');
    const engine = createEngine(db, () => {}, () => T0, { isArmed: () => false });
    engine.createDevice('admin', { id: 'I-1', kind: 'detector', category: 'intrusion', name: 'Circuit exterieur', zone: 'Cour' });
    engine.handleDetectorMessage('I-1', { event: 'patrol_missed', detail: 'aucun point scanne (8 points)' });
    engine.handleDetectorMessage('I-1', { event: 'motion' });
    const incidents = engine.getSnapshot().incidents;
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0].event, 'patrol_missed', 'le mouvement, lui, est ignore en zone desarmee');
    assert.equal(incidents[0].detail, 'aucun point scanne (8 points)');
  });

  it("logbook_report ouvre une prealarme, qui n'est PAS toujours active (masquee en zone d'intrusion desarmee)", () => {
    const db = openDb(':memory:');
    const engine = createEngine(db, () => {}, () => T0, { isArmed: () => false });
    engine.createDevice('admin', { id: 'I-2', kind: 'detector', category: 'intrusion', name: 'Agent', zone: 'Cour' });
    engine.createDevice('admin', { id: 'A-1', kind: 'detector', category: 'people', name: 'Agent Moussa', zone: 'Cour', heartbeatS: 0 });
    engine.handleDetectorMessage('I-2', { event: 'logbook_report', detail: 'anomalie : porte ouverte' });
    assert.equal(engine.getSnapshot().incidents.length, 0, 'masque : zone desarmee');
    engine.handleDetectorMessage('A-1', { event: 'logbook_report', detail: 'anomalie : porte ouverte' });
    const incident = engine.getSnapshot().incidents[0];
    assert.equal(incident.severity, 'warning');
    assert.equal(incident.event, 'logbook_report');
    assert.equal(incident.detail, 'anomalie : porte ouverte');
  });
});
