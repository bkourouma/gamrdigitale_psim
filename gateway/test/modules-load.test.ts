/**
 * Chargement des huit modules livres (heartbeat, zigbee, modbus, ups, sia, lorawan, acces-dahua, acces-zkteco) par le socle, avec les configurations
 * d'exemple de LEUR documentation (gateway/docs/<module>.md, gateway/config.example.json) :
 *  - import dynamique par le meme chemin que le runtime (moduleEntry + import), `create` exporte et validant ;
 *  - `npm run gateway:check-config` (main.ts --check) sur une configuration qui les reunit tous, contre le vrai broker du PSIM ;
 *  - secrets des modules par `{"$env": ...}` / `{"$file": ...}` (cle SIA, communaute SNMP, mots de passe des brokers et du controleur Dahua) :
 *    acceptes, et jamais recopies dans la sortie, le journal ou le fichier d'etat.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { loadConfig, moduleEntry } from '../src/config.ts';
import type { GatewayModule, ModuleFactory } from '../src/module.ts';
import { startRuntime, STATUS_FILE } from '../src/runtime.ts';
import { freePort, GW_PASSWORD, GW_USER, memoryLogger, psimBroker, ROOT, tempDir, waitFor, writeConfig } from './helpers.ts';
import type { Received } from './helpers.ts';

const MODULES = ['heartbeat', 'zigbee', 'modbus', 'ups', 'sia', 'lorawan', 'acces-dahua', 'acces-zkteco'] as const;
type Name = (typeof MODULES)[number];

/** Secrets d'essai : on verifie qu'ils n'apparaissent nulle part. */
const SIA_KEY_ENV = '00112233445566778899AABBCCDDEEFF';
const SIA_KEY_FILE = 'F0E1D2C3B4A5968778695A4B3C2D1E0F';
const COMMUNITY = 'communaute-secrete-Xq7';
const Z2M_PASSWORD = 'mot-de-passe-z2m-Kp4';
const CHIRP_PASSWORD = 'mot-de-passe-chirpstack-Wm2';
const DAHUA_PASSWORD = 'mot-de-passe-dahua-Rt5';
const SECRETS = [SIA_KEY_ENV, SIA_KEY_FILE, COMMUNITY, Z2M_PASSWORD, CHIRP_PASSWORD, DAHUA_PASSWORD];

function docBlocks(name: string): Record<string, unknown>[] {
  const text = readFileSync(join(ROOT, 'gateway', 'docs', `${name}.md`), 'utf8');
  const out: Record<string, unknown>[] = [];
  for (const m of text.matchAll(/```json\r?\n([\s\S]*?)```/g)) {
    try {
      const v = JSON.parse(m[1]!) as unknown;
      if (v && typeof v === 'object' && !Array.isArray(v)) out.push(v as Record<string, unknown>);
    } catch {
      /* fragment de documentation, pas une configuration complete */
    }
  }
  return out;
}

/**
 * L'exemple de la page acces-dahua donne le mot de passe de chaque controleur par `{"$file": ...}` (le socle le remplace avant
 * que le module ne voie sa configuration) : on verifie cette forme, puis on met un mot de passe d'essai en clair pour `create()`.
 */
function dahuaExample(block: Record<string, unknown>): Record<string, unknown> {
  for (const c of block.controllers as Record<string, unknown>[]) {
    const pw = c.password as { $file?: unknown } | undefined;
    assert.equal(typeof pw?.$file, 'string', "le mot de passe de l'exemple gateway/docs/acces-dahua.md est donne par {\"$file\": ...}");
    c.password = DAHUA_PASSWORD;
  }
  return block;
}

/** Configuration d'exemple de chaque module, telle que publiee dans sa documentation. */
function examples(): Record<Name, Record<string, unknown>> {
  const pick = (name: string, test: (b: Record<string, unknown>) => boolean): Record<string, unknown> => {
    const b = docBlocks(name).find(test);
    assert.ok(b, `exemple de configuration introuvable dans gateway/docs/${name}.md`);
    return structuredClone(b);
  };
  const example = JSON.parse(readFileSync(join(ROOT, 'gateway', 'config.example.json'), 'utf8')) as { modules: { name: string; config: Record<string, unknown> }[] };
  const hb = example.modules.find((m) => m.name === 'heartbeat');
  assert.ok(hb, 'heartbeat dans gateway/config.example.json');
  return {
    heartbeat: structuredClone(hb.config),
    zigbee: pick('zigbee', (b) => 'broker' in b && 'devices' in b),
    modbus: pick('modbus', (b) => Array.isArray(b.devices)),
    ups: pick('ups', (b) => Array.isArray(b.ups)),
    sia: pick('sia', (b) => 'listen' in b && 'accounts' in b),
    lorawan: pick('lorawan', (b) => 'broker' in b && 'devices' in b),
    'acces-dahua': dahuaExample(pick('acces-dahua', (b) => Array.isArray(b.controllers) && !('listen' in b))),
    'acces-zkteco': pick('acces-zkteco', (b) => Array.isArray(b.controllers) && 'listen' in b),
  };
}

async function load(name: string): Promise<ModuleFactory> {
  const file = moduleEntry(name);
  assert.ok(file, `gateway/src/modules/${name}/index.ts`);
  const mod = (await import(pathToFileURL(file).href)) as { create?: unknown };
  assert.equal(typeof mod.create, 'function', `${name} exporte create`);
  return mod.create as ModuleFactory;
}

const cleanup: (() => unknown)[] = [];
after(async () => {
  for (const f of cleanup.reverse()) await f();
});

describe('modules livres : chargement par le socle', () => {
  const savedKey = process.env.SIA_KEY_1A2B;
  process.env.SIA_KEY_1A2B = SIA_KEY_ENV; // l'exemple SIA lit la cle de la centrale 1A2B dans cette variable (keyEnv)
  cleanup.push(() => {
    if (savedKey === undefined) delete process.env.SIA_KEY_1A2B;
    else process.env.SIA_KEY_1A2B = savedKey;
  });

  it('chaque module s\'importe comme le runtime le fait, et accepte l\'exemple de sa documentation', async () => {
    const ex = examples();
    for (const name of MODULES) {
      const create = await load(name);
      const mod: GatewayModule = create(structuredClone(ex[name]));
      assert.equal(mod.name, name);
      assert.equal(typeof mod.start, 'function');
      assert.equal(typeof mod.stop, 'function');
    }
  });

  it('create() valide la configuration : une section vide ou erronee est refusee avec un message', async () => {
    for (const name of MODULES) {
      const create = await load(name);
      assert.throws(() => create({}), (err: Error) => err instanceof Error && err.message.length > 0, `${name} : section vide`);
      assert.throws(() => create({ cleInventee: 1 } as Record<string, unknown>), Error, `${name} : cle inconnue`);
    }
  });

  it('gateway:check-config sur une configuration reunissant les huit modules (secrets par $env / $file) : OK, aucun secret affiche', { timeout: 60_000 }, async () => {
    const dir = tempDir(cleanup);
    const port = await freePort();
    const received: Received[] = [];
    const broker = await psimBroker(port, received);
    cleanup.push(() => broker.close());
    mkdirSync(join(dir, 'secrets'));
    writeFileSync(join(dir, 'secrets', 'psim.txt'), `${GW_PASSWORD}\r\n`);
    writeFileSync(join(dir, 'secrets', 'sia-0457.txt'), `${SIA_KEY_FILE}\n`);
    writeFileSync(join(dir, 'secrets', 'z2m.txt'), Z2M_PASSWORD);
    writeFileSync(join(dir, 'secrets', 'dahua.txt'), `${DAHUA_PASSWORD}
`);

    const ex = examples();
    (ex.zigbee.broker as Record<string, unknown>).password = { $file: 'secrets/z2m.txt' };
    (ex.lorawan.broker as Record<string, unknown>).password = { $env: 'CHIRP_PASSWORD' };
    const accounts = ex.sia.accounts as Record<string, Record<string, unknown>>;
    accounts['0457']!.key = { $file: 'secrets/sia-0457.txt' };
    const snmp = (ex.ups.ups as Record<string, unknown>[]).find((u) => u.transport === 'snmp');
    assert.ok(snmp, "l'exemple de gateway/docs/ups.md contient un onduleur SNMP");
    snmp.community = { $env: 'UPS_COMMUNITY' };
    for (const c of ex['acces-dahua'].controllers as Record<string, unknown>[]) c.password = { $file: 'secrets/dahua.txt' };

    const file = writeConfig(dir, {
      name: 'essai-huit-modules',
      psim: { url: `mqtt://127.0.0.1:${port}`, username: GW_USER, passwordFile: 'secrets/psim.txt' },
      dataDir: 'data',
      log: { file: false },
      modules: MODULES.map((name) => ({ name, config: ex[name] })),
    });
    const env = { ...process.env, SIA_KEY_1A2B: SIA_KEY_ENV, UPS_COMMUNITY: COMMUNITY, CHIRP_PASSWORD };
    const child = spawn(process.execPath, [join(ROOT, 'gateway', 'src', 'main.ts'), file, '--check'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    const code = await new Promise<number | null>((r) => child.on('exit', r));
    assert.equal(code, 0, out);
    for (const name of MODULES) assert.match(out, new RegExp(`\\(${name}\\) : configuration acceptee`), out);
    assert.match(out, /PSIM joignable, identifiants acceptes/);
    assert.match(out.trim(), /OK$/);
    for (const s of [...SECRETS, GW_PASSWORD]) assert.equal(out.includes(s), false, `secret affiche : ${s.slice(0, 4)}...`);
  });

  it('secrets SIA et SNMP par $file / $env : le runtime demarre les modules, et ni le journal ni le fichier d\'etat ne les contiennent', { timeout: 60_000 }, async () => {
    const dir = tempDir(cleanup);
    const port = await freePort();
    const siaPort = await freePort();
    const snmpPort = await freePort();
    const received: Received[] = [];
    const broker = await psimBroker(port, received, [{ user: GW_USER, password: GW_PASSWORD, detectors: ['GW-*'] }]);
    cleanup.push(() => broker.close());
    mkdirSync(join(dir, 'secrets'));
    writeFileSync(join(dir, 'secrets', 'sia.txt'), SIA_KEY_FILE);
    const saved = process.env.UPS_COMMUNITY;
    process.env.UPS_COMMUNITY = COMMUNITY;
    cleanup.push(() => {
      if (saved === undefined) delete process.env.UPS_COMMUNITY;
      else process.env.UPS_COMMUNITY = saved;
    });
    const file = writeConfig(dir, {
      psim: { url: `mqtt://127.0.0.1:${port}`, username: GW_USER, password: GW_PASSWORD },
      dataDir: 'data',
      retry: { minMs: 100, maxMs: 400 },
      moduleRetry: { minMs: 100, maxMs: 400 },
      log: { file: false },
      modules: [
        { name: 'heartbeat', config: { deviceId: 'GW-01', everyS: 60 } },
        { name: 'sia', config: { listen: { host: '127.0.0.1', port: siaPort }, accounts: { '1234': { key: { $file: 'secrets/sia.txt' }, defaultId: 'GW-SIA' } } } },
        { name: 'ups', config: { ups: [{ name: 'baie', transport: 'snmp', host: '127.0.0.1', port: snmpPort, community: { $env: 'UPS_COMMUNITY' }, pollMs: 200, timeoutMs: 100, ids: { status: 'GW-UPS' } }] } },
      ],
    });
    const config = loadConfig(file);
    const logger = memoryLogger();
    const rt = await startRuntime({ config, logger });
    cleanup.push(() => rt.stop());
    await waitFor(() => rt.status().modules.every((m) => m.state === 'running'), 10_000, 'trois modules demarres');
    await waitFor(() => received.some((r) => r.id === 'GW-01'), 10_000, 'signe de vie recu par le PSIM');
    // L'onduleur ne repond pas (aucun agent SNMP) : quelques echecs journalises, avec l'adresse mais jamais la communaute.
    await waitFor(() => logger.lines.length >= 5, 10_000, 'journal');
    await new Promise((r) => setTimeout(r, 1500));
    await rt.stop();
    const status = readFileSync(join(config.dataDir, STATUS_FILE), 'utf8');
    const text = logger.lines.map((l) => l.text).join('\n');
    for (const s of SECRETS) {
      assert.equal(text.includes(s), false, `secret dans le journal : ${s.slice(0, 4)}...`);
      assert.equal(status.includes(s), false, `secret dans ${STATUS_FILE} : ${s.slice(0, 4)}...`);
    }
  });
});
