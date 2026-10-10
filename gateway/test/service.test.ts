/**
 * Installation Windows (scripts/gateway-service.ps1) : le script se lit sans erreur, et son controle « dossier modifiable par
 * des utilisateurs ordinaires » est IDENTIQUE a celui du PSIM (windows-service.ps1). Rien n'est installe ni execute.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { statusProbe } from '../src/supervise.ts';
import { ROOT } from './helpers.ts';

const SCRIPT = join(ROOT, 'scripts', 'gateway-service.ps1');
const fn = (file: string) => {
  const text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const m = /function Get-WritableByOrdinaryUsers \{[\s\S]*?\n\}\n/.exec(text);
  assert.ok(m, file);
  return m[0];
};

describe('installation Windows de la passerelle', () => {
  it('durcissement identique au PSIM (meme fonction de controle des droits)', () => {
    assert.equal(fn(SCRIPT), fn(join(ROOT, 'scripts', 'windows-service.ps1')));
  });

  it('script en ASCII (PowerShell 5.1 lit sans BOM en ANSI) et lisible sans erreur', { skip: process.platform === 'win32' ? false : 'PowerShell/Windows requis' }, () => {
    assert.ok(/^[\x00-\x7f]*$/.test(readFileSync(SCRIPT, 'utf8')), 'caractere non ASCII');
    const ps = `$tokens = $null; $errors = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('${SCRIPT.replace(/'/g, "''")}', [ref]$tokens, [ref]$errors); $errors.Count`;
    const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), '0', r.stdout);
  });
});

describe('superviseur de la passerelle', () => {
  it("sonde : fichier d'etat frais = sain ; ancien ou absent = bloquee (arret force puis relance apres 3 echecs)", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gamr-gw-sup-'));
    try {
      const config = join(dir, 'gw.json');
      writeFileSync(config, JSON.stringify({ dataDir: 'donnees' }));
      const probe = statusProbe(config, 90_000);
      assert.equal((await probe()).ok, false, 'absent');
      mkdirSync(join(dir, 'donnees'));
      writeFileSync(join(dir, 'donnees', 'status.json'), JSON.stringify({ at: Date.now() }));
      assert.equal((await probe()).ok, true);
      writeFileSync(join(dir, 'donnees', 'status.json'), JSON.stringify({ at: Date.now() - 200_000 }));
      const r = await probe();
      assert.equal(r.ok, false);
      assert.match(r.detail ?? '', /non mis a jour depuis 200 s/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
