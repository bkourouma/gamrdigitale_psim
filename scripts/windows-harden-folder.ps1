<#
.SYNOPSIS
  Retire aux "Utilisateurs authentifies" le droit de MODIFIER le dossier du PSIM (et tout ce qu'il contient).

.DESCRIPTION
  Sous Windows, un dossier cree hors de "Program Files" (par exemple D:\APP\...) herite souvent du droit
  "Utilisateurs authentifies : Modification". N'importe quel compte local peut alors changer le code du PSIM, qui
  s'executerait ensuite avec les droits du compte qui le lance (SYSTEM pour un service). `windows-service.ps1`
  refuse d'installer tant que c'est le cas.

  Ce script, a lancer VOUS-MEME (il modifie des droits d'acces) :
    1. convertit les droits herites du dossier en droits explicites (la structure existante est conservee) ;
    2. vous donne explicitement le controle total (vous ne perdez pas l'ecriture) ;
    3. retire "Utilisateurs authentifies" (et "Tout le monde" s'il a l'ecriture).
  Administrateurs et SYSTEM gardent le controle total ; le groupe "Utilisateurs" garde la lecture seule.

  Ajouter -WhatIf pour VOIR les commandes sans rien modifier. Reversible : `icacls <dossier> /inheritance:e` rend
  l'heritage, puis `icacls <dossier> /grant "*S-1-5-11:(OI)(CI)M"` redonne le droit retire.

  Aucun droit d'administrateur n'est necessaire si vous etes PROPRIETAIRE du dossier (cas d'un dossier que vous avez cree).
  A savoir : si le PSIM tourne sous un autre compte que le votre (un compte de service), donnez-lui le droit d'ECRIRE dans
  son seul dossier de donnees (data-prod) avec : icacls "<dossier>\data-prod" /grant "<compte>:(OI)(CI)M"

.EXAMPLE
  .\scripts\windows-harden-folder.ps1 -WhatIf
  .\scripts\windows-harden-folder.ps1
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    # Dossier a proteger (par defaut : le dossier du PSIM).
    [string]$Path = ''
)

$ErrorActionPreference = 'Stop'
if (-not $Path) { $Path = Split-Path -Parent $PSScriptRoot }
$Path = (Resolve-Path $Path).Path
$me = [Security.Principal.WindowsIdentity]::GetCurrent()
$isAdmin = ([Security.Principal.WindowsPrincipal]$me).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

function Get-WritableByOrdinaryUsers {
    param([string[]]$Paths)
    $risky = @('S-1-1-0', 'S-1-5-11', 'S-1-5-32-545')   # Tout le monde, Utilisateurs authentifies, Utilisateurs
    $write = [Security.AccessControl.FileSystemRights]'WriteData, CreateFiles, AppendData, Write, Modify, FullControl'
    $found = @()
    foreach ($p in $Paths) {
        if (-not (Test-Path $p)) { continue }
        foreach ($rule in (Get-Acl $p).Access) {
            if ($rule.AccessControlType -ne 'Allow') { continue }
            try { $sid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value } catch { continue }
            if (($risky -contains $sid) -and (($rule.FileSystemRights -band $write) -ne 0)) { $found += "$p : $($rule.IdentityReference)"; break }
        }
    }
    return $found
}

$watch = @($Path, (Join-Path $Path 'server'), (Join-Path $Path 'scripts'), (Join-Path $Path 'node_modules'))
$before = Get-WritableByOrdinaryUsers -Paths $watch
if ($before.Count -eq 0) {
    Write-Host "Rien a faire : $Path n'est modifiable par aucun utilisateur ordinaire (hors vous, administrateurs et SYSTEM)."
    return
}

# Sans droit d'administrateur, on ne peut changer les droits que d'un dossier dont on est proprietaire.
$owner = (Get-Acl $Path).Owner
if (-not $isAdmin -and $owner -notlike "*\$($env:USERNAME)") {
    throw "Ce dossier appartient a '$owner' : seul son proprietaire ou un administrateur peut changer ses droits. Relancez ce script dans un PowerShell ouvert en administrateur."
}

Write-Host "Dossier : $Path"
Write-Host "Modifiable aujourd'hui par :"
$before | ForEach-Object { Write-Host "  $_" }
Write-Host "Vous ($($me.Name)) garderez le controle total ; administrateurs et SYSTEM aussi ; les autres : lecture seule."

# icacls : /inheritance:d garde les droits herites comme droits explicites ; /remove:g retire les droits ACCORDES a un groupe.
$steps = @(
    @('/inheritance:d'),
    @('/grant', "$($me.Name):(OI)(CI)F"),
    @('/remove:g', '*S-1-5-11'),   # Utilisateurs authentifies
    @('/remove:g', '*S-1-1-0')     # Tout le monde (s'il avait un droit d'ecriture)
)
foreach ($step in $steps) {
    if ($PSCmdlet.ShouldProcess($Path, "icacls $($step -join ' ')")) {
        & icacls $Path @step | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "icacls $($step -join ' ') a echoue (code $LASTEXITCODE). Rien d'autre n'a ete modifie apres cette etape." }
    }
}

if (-not $WhatIfPreference) {
    $after = Get-WritableByOrdinaryUsers -Paths $watch
    if ($after.Count -eq 0) { Write-Host "Termine : plus aucun utilisateur ordinaire ne peut modifier le dossier du PSIM." }
    else { Write-Warning ("Il reste des droits d'ecriture :`n  " + ($after -join "`n  ")) }
}
