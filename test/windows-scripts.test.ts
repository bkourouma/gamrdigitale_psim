/**
 * Les scripts PowerShell (windows-service.ps1, windows-harden-folder.ps1) controlent « le dossier est-il modifiable par des
 * utilisateurs ordinaires ? ». Ce test execute la VRAIE fonction sur des droits d'acces fabriques : aucun droit reel n'est lu
 * ni modifie. Il a ete ajoute apres un defaut reel : un masque contenant FullControl comptait la lecture seule comme de l'ecriture.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';

const ROOT = resolve(import.meta.dirname, '..');
const WINDOWS = process.platform === 'win32';

// Valeurs FileSystemRights reelles (entiers) : lecture+execution, droits generiques, creation de fichiers / sous-dossiers,
// modification, controle total.
const READ_EXECUTE = 1179817;
const GENERIC_READ_EXECUTE = -1610612736;
const CREATE_FILES_APPEND = 0x6;
const MODIFY = 1245631;
const FULL_CONTROL = 2032127;
const GENERIC_WRITE = 0x40000000;

function flagged(script: string, rules: { sid: string; rights: number; type?: 'Allow' | 'Deny' }[]): string[] {
  const rulesPs = rules.map((r) => `@{ Sid = '${r.sid}'; Rights = ${r.rights}; Type = '${r.type ?? 'Allow'}' }`).join(', ');
  const ps = `
$ErrorActionPreference = 'Stop'
$file = '${join(ROOT, 'scripts', script).replace(/\\/g, '\\\\')}'
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($file, [ref]$tokens, [ref]$errors)
$fn = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Get-WritableByOrdinaryUsers' }, $true)[0]
Invoke-Expression $fn.Extent.Text
function Test-Path { param($p) $true }
function Get-Acl {
    param($p)
    $access = foreach ($r in @(${rulesPs})) {
        $sidObject = New-Object Security.Principal.SecurityIdentifier($r.Sid)
        $identity = [pscustomobject]@{ Value = $r.Sid }
        $identity | Add-Member -MemberType ScriptMethod -Name Translate -Value { param($t) $sidObject }.GetNewClosure() -Force
        $identity | Add-Member -MemberType ScriptMethod -Name ToString -Value { $r.Sid }.GetNewClosure() -Force
        [pscustomobject]@{ AccessControlType = $r.Type; FileSystemRights = [Enum]::ToObject([Security.AccessControl.FileSystemRights], [int]$r.Rights); IdentityReference = $identity }
    }
    [pscustomobject]@{ Access = @($access) }
}
$found = Get-WritableByOrdinaryUsers -Paths @('X:\\dossier')
$found.Count
`;
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  return Array.from({ length: Number(r.stdout.trim().split(/\r?\n/).pop()) }, () => 'x');
}

const USERS = 'S-1-5-32-545';
const AUTHENTICATED = 'S-1-5-11';
const EVERYONE = 'S-1-1-0';
const ADMINS = 'S-1-5-32-544';

for (const script of ['windows-service.ps1', 'windows-harden-folder.ps1']) {
  describe(`${script} : detection d'un dossier modifiable`, { skip: WINDOWS ? false : 'PowerShell/Windows requis' }, () => {
    it("la lecture seule du groupe « Utilisateurs » n'est PAS de l'ecriture (le defaut qui bloquait tout)", () => {
      assert.equal(flagged(script, [{ sid: USERS, rights: READ_EXECUTE }]).length, 0);
      assert.equal(flagged(script, [{ sid: USERS, rights: GENERIC_READ_EXECUTE }]).length, 0);
      assert.equal(flagged(script, [{ sid: USERS, rights: READ_EXECUTE }, { sid: USERS, rights: GENERIC_READ_EXECUTE }, { sid: ADMINS, rights: FULL_CONTROL }]).length, 0);
    });

    it("signale « Utilisateurs authentifies » avec Modification, « Tout le monde » en controle total, et la simple creation de fichiers", () => {
      assert.equal(flagged(script, [{ sid: AUTHENTICATED, rights: MODIFY }]).length, 1);
      assert.equal(flagged(script, [{ sid: EVERYONE, rights: FULL_CONTROL }]).length, 1);
      assert.equal(flagged(script, [{ sid: USERS, rights: CREATE_FILES_APPEND }]).length, 1, 'creer un fichier suffit a detourner un module');
      assert.equal(flagged(script, [{ sid: USERS, rights: GENERIC_WRITE }]).length, 1);
    });

    it("ignore les administrateurs (controle total legitime) et les regles de REFUS", () => {
      assert.equal(flagged(script, [{ sid: ADMINS, rights: FULL_CONTROL }]).length, 0);
      assert.equal(flagged(script, [{ sid: AUTHENTICATED, rights: MODIFY, type: 'Deny' }]).length, 0);
    });
  });
}
