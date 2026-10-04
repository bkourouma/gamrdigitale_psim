<#
.SYNOPSIS
  Demarrage automatique du PSIM sous Windows, avec redemarrage apres panne (taches planifiees).

.DESCRIPTION
  Cree deux taches planifiees, sans logiciel supplementaire :
    - "PSIM"             : lance le PSIM au demarrage de la machine (sans session ouverte), le relance
                           automatiquement s'il s'arrete (toutes les minutes, sans limite de tentatives).
    - "PSIM-healthcheck" : toutes les minutes, verifie /healthz ; apres 3 echecs consecutifs, arrete le PSIM
                           bloque pour que la tache "PSIM" le relance.

  Deux modes :
    - SERVICE (par defaut) : demarre avec la machine, meme sans session ouverte ; demande un PowerShell OUVERT EN
      ADMINISTRATEUR (compte SYSTEM ou compte de service dedie).
    - -AtLogon : pour un poste ordinaire, SANS droits d'administrateur : demarre a l'OUVERTURE DE SESSION de l'utilisateur
      courant et tourne sous son compte. Le PSIM ne tourne donc que session ouverte ; a reserver aux postes ou quelqu'un se
      connecte en permanence (poste de supervision), sinon preferer le mode service.

  A lancer depuis le dossier du projet :

    .\scripts\windows-service.ps1 -Action Install            # installe et demarre
    .\scripts\windows-service.ps1 -Action Status             # etat
    .\scripts\windows-service.ps1 -Action Stop               # arrete (sans desinstaller)
    .\scripts\windows-service.ps1 -Action Start
    .\scripts\windows-service.ps1 -Action Uninstall          # retire les deux taches

  Ajouter -WhatIf pour VOIR ce qui serait fait sans rien modifier.

  Les journaux sont dans data\logs\psim.log (PSIM_LOG_FILE, actif par defaut en production).
  Avant d'installer : copier .env.example en .env, y mettre PSIM_ENV=production et vos mots de passe, puis
  verifier avec "npm run check-config".
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Install', 'Uninstall', 'Status', 'Start', 'Stop')]
    [string]$Action,

    # Compte qui execute le PSIM. Par defaut SYSTEM ; preferer un compte de service dedie, a droits limites.
    [string]$User = 'SYSTEM',

    # Delai (secondes) du controle de sante, et nombre d'echecs avant redemarrage.
    [int]$HealthFailures = 3,

    # Fichier d'environnement (dans le dossier du PSIM). `npm run init-production` ecrit .env.production.
    # Lecture STRICTE : un fichier absent ou illisible arrete le PSIM au lieu de le laisser demarrer avec les valeurs de demonstration.
    [string]$EnvFile = '.env',

    # Installer malgre un dossier modifiable par des utilisateurs ordinaires (deconseille : voir l'avertissement).
    [switch]$AllowWritableTree,

    # Mode poste ordinaire : tache de l'utilisateur courant, lancee a l'ouverture de session, sans administrateur.
    [switch]$AtLogon
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$MainTask = 'PSIM'
$HealthTask = 'PSIM-healthcheck'

function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    return ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# Un PSIM lance en SYSTEM depuis un dossier que n'importe quel utilisateur local peut modifier = execution de code en SYSTEM pour
# tout compte local (il suffit de changer server\*.ts ou node_modules). On refuse tant que ce n'est pas corrige.
function Get-WritableByOrdinaryUsers {
    param([string[]]$Paths)
    $risky = @('S-1-1-0', 'S-1-5-11', 'S-1-5-32-545')   # Tout le monde, Utilisateurs authentifies, Utilisateurs
    # Bits d'ECRITURE seulement (jamais FullControl : il contient tous les bits, lecture comprise, et ferait passer la lecture seule pour une ecriture).
    # Ecrire/creer 0x2, ajouter 0x4, attributs 0x10 et 0x100, supprimer dans le dossier 0x40, supprimer 0x10000, changer les droits 0x40000,
    # prendre possession 0x80000, et les droits generiques ecriture 0x40000000 / tout 0x10000000.
    $write = 0x500D0156
    $found = @()
    foreach ($p in $Paths) {
        if (-not (Test-Path $p)) { continue }
        foreach ($rule in (Get-Acl $p).Access) {
            if ($rule.AccessControlType -ne 'Allow') { continue }
            try { $sid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value } catch { continue }
            if (($risky -contains $sid) -and ((([int]$rule.FileSystemRights) -band $write) -ne 0)) { $found += "$p : $($rule.IdentityReference)"; break }
        }
    }
    return $found
}

function Get-NodePath {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if (-not $cmd) { throw "Node.js est introuvable dans le PATH. Installez Node.js 24 ou plus." }
    return $cmd.Source
}

if ($Action -in 'Install', 'Uninstall', 'Start', 'Stop' -and -not $AtLogon -and -not $WhatIfPreference -and -not (Test-Admin)) {
    throw "Cette action demande un PowerShell ouvert en administrateur (clic droit > Executer en tant qu'administrateur)."
}

switch ($Action) {
    'Install' {
        $node = Get-NodePath
        if (-not (Test-Path (Join-Path $Root $EnvFile))) {
            throw "Fichier d'environnement introuvable : $(Join-Path $Root $EnvFile). Creez-le (npm run init-production, ou copiez .env.example) : sans lui le PSIM demarrerait avec les mots de passe de demonstration."
        }
        $writable = Get-WritableByOrdinaryUsers -Paths @($Root, (Join-Path $Root 'server'), (Join-Path $Root 'scripts'), (Join-Path $Root 'node_modules'))
        if ($writable.Count -gt 0 -and -not $AllowWritableTree) {
            throw ("Le dossier du PSIM est MODIFIABLE par des utilisateurs ordinaires :`n  " + ($writable -join "`n  ") + "`nUn PSIM lance par une tache planifiee executerait leur code avec les droits du compte de service. Corrigez les droits, par exemple (PowerShell administrateur ; ATTENTION : cela retire l'ecriture aux utilisateurs ordinaires, vous compris si vous n'etes pas administrateur) :`n  icacls `"$Root`" /inheritance:r /grant:r `"*S-1-5-18:(OI)(CI)F`" `"*S-1-5-32-544:(OI)(CI)F`" `"*S-1-5-32-545:(OI)(CI)RX`"`npuis donnez au compte de service le droit d'ECRIRE dans le seul dossier de donnees. (-AllowWritableTree pour passer outre, deconseille.)")
        }
        $principal = if ($AtLogon) {
            New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
        } elseif ($User -eq 'SYSTEM') {
            New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
        } else {
            $cred = Get-Credential -UserName $User -Message "Mot de passe du compte qui executera le PSIM"
            New-ScheduledTaskPrincipal -UserId $User -LogonType Password -RunLevel Limited
        }

        # --- Tache principale : demarrage au boot, relance automatique -------------------------------------------
        $run = New-ScheduledTaskAction -Execute $node -Argument "--env-file=$EnvFile server/index.ts" -WorkingDirectory $Root
        $boot = if ($AtLogon) { New-ScheduledTaskTrigger -AtLogOn -User ([Security.Principal.WindowsIdentity]::GetCurrent().Name) } else { New-ScheduledTaskTrigger -AtStartup }
        $settings = New-ScheduledTaskSettingsSet `
            -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
            -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
            -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
            -MultipleInstances IgnoreNew

        # --- Controle de sante : toutes les minutes, redemarre un PSIM bloque -------------------------------------
        $checkAction = New-ScheduledTaskAction -Execute $node -Argument "--env-file=$EnvFile scripts/healthcheck.ts --restart $HealthFailures" -WorkingDirectory $Root
        $everyMinute = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Minutes 1)
        $checkSettings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 1) -StartWhenAvailable -MultipleInstances IgnoreNew

        if ($PSCmdlet.ShouldProcess("$MainTask et $HealthTask", "Creer les taches planifiees (dossier : $Root, compte : $(if ($AtLogon) { $env:USERNAME + ', ouverture de session, sans administrateur' } else { $User }))")) {
            if ($AtLogon) {
                Register-ScheduledTask -TaskName $MainTask -Action $run -Trigger $boot -Settings $settings -Principal $principal -Description 'GAMRdigitale PSIM (ouverture de session)' -Force | Out-Null
                Register-ScheduledTask -TaskName $HealthTask -Action $checkAction -Trigger $everyMinute -Settings $checkSettings -Principal $principal -Description 'Controle de sante du PSIM' -Force | Out-Null
            } elseif ($User -eq 'SYSTEM') {
                Register-ScheduledTask -TaskName $MainTask -Action $run -Trigger $boot -Settings $settings -Principal $principal -Description 'GAMRdigitale PSIM' -Force | Out-Null
                Register-ScheduledTask -TaskName $HealthTask -Action $checkAction -Trigger $everyMinute -Settings $checkSettings -Principal $principal -Description 'Controle de sante du PSIM' -Force | Out-Null
            } else {
                $plain = $cred.GetNetworkCredential().Password
                Register-ScheduledTask -TaskName $MainTask -Action $run -Trigger $boot -Settings $settings -User $User -Password $plain -RunLevel Limited -Description 'GAMRdigitale PSIM' -Force | Out-Null
                Register-ScheduledTask -TaskName $HealthTask -Action $checkAction -Trigger $everyMinute -Settings $checkSettings -User $User -Password $plain -RunLevel Limited -Description 'Controle de sante du PSIM' -Force | Out-Null
            }
            Start-ScheduledTask -TaskName $MainTask
            Write-Host $(if ($AtLogon) { "Installe (mode ouverture de session). Le PSIM demarre maintenant et a chaque ouverture de session de $env:USERNAME ; il est relance s'il s'arrete." } else { "Installe. Le PSIM demarre maintenant et a chaque demarrage de la machine ; il est relance s'il s'arrete." })
            # Le dossier de donnees est celui du fichier d'environnement (data-prod pour init-production), pas forcement "data".
            $dataDir = 'data'
            $line = Select-String -Path (Join-Path $Root $EnvFile) -Pattern '^\s*PSIM_DATA_DIR=(.+)$' | Select-Object -First 1
            if ($line) { $dataDir = $line.Matches[0].Groups[1].Value.Trim().Trim('"') }
            $logDir = if ([IO.Path]::IsPathRooted($dataDir)) { $dataDir } else { Join-Path $Root $dataDir }
            Write-Host "Journaux : $(Join-Path $logDir 'logs\psim.log')"
        }
    }
    'Uninstall' {
        foreach ($name in $MainTask, $HealthTask) {
            if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
                if ($PSCmdlet.ShouldProcess($name, 'Supprimer la tache planifiee')) {
                    Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
                    Unregister-ScheduledTask -TaskName $name -Confirm:$false
                    Write-Host "Tache $name supprimee."
                }
            } else {
                Write-Host "Tache $name : absente."
            }
        }
        Write-Host "Les donnees (dossier data\) ne sont pas touchees. Si le PSIM tourne encore, l'arreter avec Stop avant, ou redemarrer la machine."
    }
    'Start' { if ($PSCmdlet.ShouldProcess($MainTask, 'Demarrer')) { Start-ScheduledTask -TaskName $MainTask; Write-Host 'Demarre.' } }
    'Stop'  { if ($PSCmdlet.ShouldProcess($MainTask, 'Arreter')) { Stop-ScheduledTask -TaskName $MainTask; Write-Host 'Arrete (il redemarrera au prochain demarrage de la machine).' } }
    'Status' {
        foreach ($name in $MainTask, $HealthTask) {
            $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
            if (-not $task) { Write-Host ("{0,-18} non installee" -f $name); continue }
            $info = Get-ScheduledTaskInfo -TaskName $name
            Write-Host ("{0,-18} {1,-10} dernier resultat : {2} ; derniere execution : {3}" -f $name, $task.State, $info.LastTaskResult, $info.LastRunTime)
        }
    }
}
