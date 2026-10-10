/** Configuration : validation stricte, secrets, noms de modules pieges, ligne de commande. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { ConfigError, loadConfig, moduleEntry } from '../src/config.ts';
import { FIXTURES, ROOT, tempDir, writeConfig } from './helpers.ts';

const cleanup: (() => void)[] = [];
after(() => cleanup.forEach((f) => f()));

const base = (extra: Record<string, unknown> = {}) => ({
  psim: { url: 'mqtt://127.0.0.1:1883', username: 'gw1', password: 'Mot-de-passe-passerelle-1' },
  modules: [],
  ...extra,
});

function errorsOf(dir: string, cfg: unknown, env: NodeJS.ProcessEnv = {}): string[] {
  const file = writeConfig(dir, cfg as Record<string, unknown>);
  try {
    loadConfig(file, { env, modulesDir: FIXTURES });
  } catch (err) {
    assert.ok(err instanceof ConfigError, String(err));
    return err.errors;
  }
  return [];
}

describe('configuration de la passerelle', () => {
  it('valeurs par defaut, chemins relatifs au fichier, mot de passe lu dans un fichier', () => {
    const dir = tempDir(cleanup);
    mkdirSync(join(dir, 'secrets'));
    writeFileSync(join(dir, 'secrets', 'pw.txt'), 'Mot-de-passe-passerelle-1\r\n');
    const file = writeConfig(dir, { psim: { url: 'mqtt://127.0.0.1:1883', username: 'gw1', passwordFile: 'secrets/pw.txt' }, modules: [{ name: 'probe', config: { key: 'x' } }] });
    const c = loadConfig(file, { modulesDir: FIXTURES });
    assert.equal(c.psim.password, 'Mot-de-passe-passerelle-1');
    assert.equal(c.dataDir, join(dir, 'data'));
    assert.deepEqual(c.queue, { maxMessages: 10_000, maxBytes: 20 * 1024 * 1024 });
    assert.equal(c.modules[0].label, 'probe');
    assert.doesNotMatch(c.psim.passwordSource, /Mot-de-passe/);
  });

  it('secrets des modules : {"$env"} et {"$file"} remplaces ; variable absente = erreur claire', () => {
    const dir = tempDir(cleanup);
    writeFileSync(join(dir, 'z2m.txt'), 'secret-fichier\n');
    const file = writeConfig(dir, base({ modules: [{ name: 'probe', config: { key: 'x', a: { $env: 'Z2M_PW' }, b: [{ $file: 'z2m.txt' }] } }] }));
    const c = loadConfig(file, { env: { Z2M_PW: 'secret-env' }, modulesDir: FIXTURES });
    assert.equal(c.modules[0].config.a, 'secret-env');
    assert.deepEqual(c.modules[0].config.b, ['secret-fichier']);
    const errs = errorsOf(dir, base({ modules: [{ name: 'probe', config: { a: { $env: 'ABSENTE' } } }] }));
    assert.ok(errs.some((e) => /ABSENTE est absente/.test(e)), errs.join('\n'));
  });

  it('nom de module piege (traversee de chemin, separateurs, majuscules, point) : refuse', () => {
    const dir = tempDir(cleanup);
    for (const name of ['../probe', '..', '../../src/main', 'a/b', 'a\\b', 'C:\\x', '.probe', 'probe.ts', 'Probe', '', 'x'.repeat(33)]) {
      const errs = errorsOf(dir, base({ modules: [{ name }] }));
      assert.ok(errs.some((e) => /nom de module refuse/.test(e)), `${name} : ${errs.join(' | ')}`);
      assert.equal(moduleEntry(name, FIXTURES), null);
    }
    // Nom bien forme mais module absent : erreur claire, pas d'import.
    const errs = errorsOf(dir, base({ modules: [{ name: 'zigbee-inexistant' }] }));
    assert.ok(errs.some((e) => /introuvable/.test(e)));
  });

  it('configuration invalide : TOUTES les erreurs listees, en francais', () => {
    const dir = tempDir(cleanup);
    const errs = errorsOf(dir, {
      psim: { url: 'http://x', username: 'gw 1', password: 'a', passwordEnv: 'B' },
      queue: { maxMessages: 0 },
      retry: { minMs: 5000, maxMs: 100 },
      modules: [{ name: 'probe' }, { name: 'probe' }, { name: 'probe', label: 'p2', frequence: 3 }],
      inconnu: true,
    });
    const want = [/cle inconnue « inconnu »/, /psim.url : mqtt:\/\/ ou mqtts:\/\//, /psim.username/, /UNE source de mot de passe/, /queue.maxMessages/, /maxMs doit etre superieur/, /apparait deux fois/, /cle inconnue « frequence »/];
    for (const re of want) assert.ok(errs.some((e) => re.test(e)), `${re} absent de :\n${errs.join('\n')}`);
  });

  it("identifiants dans l'adresse refuses (ils finiraient dans les journaux) ; fichier absent ou JSON casse : message clair", () => {
    const dir = tempDir(cleanup);
    const errs = errorsOf(dir, base({ psim: { url: 'mqtt://gw1:secret@127.0.0.1:1883', username: 'gw1', password: 'x' } }));
    assert.ok(errs.some((e) => /pas d'identifiant dans l'adresse/.test(e)));
    assert.throws(() => loadConfig(join(dir, 'absent.json')), /fichier introuvable/);
    writeFileSync(join(dir, 'casse.json'), '{ "psim": ');
    assert.throws(() => loadConfig(join(dir, 'casse.json')), /JSON illisible/);
  });

  it("ligne de commande : configuration invalide = code 2, sans jamais afficher le mot de passe", () => {
    const dir = tempDir(cleanup);
    const file = writeConfig(dir, { psim: { url: 'mqtt://127.0.0.1:1', username: 'gw1', password: 'Secret-Tres-Visible-42' }, modules: [{ name: '../../server/index' }] });
    const r = spawnSync(process.execPath, ['gateway/src/main.ts', file], { cwd: ROOT, encoding: 'utf8', timeout: 30_000 });
    assert.equal(r.status, 2, r.stderr + r.stdout);
    assert.match(r.stderr, /Configuration invalide/);
    assert.match(r.stderr, /nom de module refuse/);
    assert.doesNotMatch(r.stderr + r.stdout, /Secret-Tres-Visible-42/);
  });

  it('verification (--check) : module accepte, PSIM injoignable signale (code 1), mot de passe jamais affiche', () => {
    const dir = tempDir(cleanup);
    const file = writeConfig(dir, { psim: { url: 'mqtt://127.0.0.1:1', username: 'gw1', password: 'Secret-Tres-Visible-42' }, modules: [{ name: 'heartbeat', config: { deviceId: 'GW-01' } }] });
    const r = spawnSync(process.execPath, ['gateway/src/main.ts', '--check', file], { cwd: ROOT, encoding: 'utf8', timeout: 30_000 });
    assert.equal(r.status, 1, r.stderr + r.stdout);
    assert.match(r.stdout, /heartbeat \(heartbeat\) : configuration acceptee/);
    assert.match(r.stdout, /connexion {4}: ECHEC/);
    assert.doesNotMatch(r.stderr + r.stdout, /Secret-Tres-Visible-42/);
  });
});
