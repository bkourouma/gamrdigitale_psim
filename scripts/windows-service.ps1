<#
.SYNOPSIS
  Demarrage automatique du PSIM sous Windows, avec redemarrage apres panne (taches planifiees).

.DESCRIPTION
  Cree deux taches planifiees, sans logiciel supplementaire :
    - "PSIM"             : lance le PSIM au demarrage de la machine (sans session ouverte), le relance
                           automatiquement s'il s'arrete (toutes les minutes, sans limite de tentatives).
    - "PSIM-healthcheck" : toutes les minutes, verifie /healthz ; apres 3 echecs consecutifs, arrete le PSIM
                           bloque pour que la tache "PSIM" le relance.

  A lancer dans un PowerShell OUVERT EN ADMINISTRATEUR, depuis le dossier du projet :

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
    [int]$HealthFailures = 3
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$MainTask = 'PSIM'
$HealthTask = 'PSIM-healthcheck'

function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    return ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-NodePath {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if (-not $cmd) { throw "Node.js est introuvable dans le PATH. Installez Node.js 24 ou plus." }
    return $cmd.Source
}

if ($Action -in 'Install', 'Uninstall', 'Start', 'Stop' -and -not $WhatIfPreference -and -not (Test-Admin)) {
    throw "Cette action demande un PowerShell ouvert en administrateur (clic droit > Executer en tant qu'administrateur)."
}

switch ($Action) {
    'Install' {
        $node = Get-NodePath
        if (-not (Test-Path (Join-Path $Root '.env'))) {
            Write-Warning "Pas de fichier .env : le PSIM demarrera avec les valeurs par defaut (mots de passe de demonstration). Voir .env.example."
        }
        $principal = if ($User -eq 'SYSTEM') {
            New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
        } else {
            $cred = Get-Credential -UserName $User -Message "Mot de passe du compte qui executera le PSIM"
            New-ScheduledTaskPrincipal -UserId $User -LogonType Password -RunLevel Limited
        }

        # --- Tache principale : demarrage au boot, relance automatique -------------------------------------------
        $run = New-ScheduledTaskAction -Execute $node -Argument '--env-file-if-exists=.env server/index.ts' -WorkingDirectory $Root
        $boot = New-ScheduledTaskTrigger -AtStartup
        $settings = New-ScheduledTaskSettingsSet `
            -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
            -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
            -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
            -MultipleInstances IgnoreNew

        # --- Controle de sante : toutes les minutes, redemarre un PSIM bloque -------------------------------------
        $checkAction = New-ScheduledTaskAction -Execute $node -Argument "--env-file-if-exists=.env scripts/healthcheck.ts --restart $HealthFailures" -WorkingDirectory $Root
        $everyMinute = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Minutes 1)
        $checkSettings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 1) -StartWhenAvailable -MultipleInstances IgnoreNew

        if ($PSCmdlet.ShouldProcess("$MainTask et $HealthTask", "Creer les taches planifiees (dossier : $Root, compte : $User)")) {
            if ($User -eq 'SYSTEM') {
                Register-ScheduledTask -TaskName $MainTask -Action $run -Trigger $boot -Settings $settings -Principal $principal -Description 'GAMRdigitale PSIM' -Force | Out-Null
                Register-ScheduledTask -TaskName $HealthTask -Action $checkAction -Trigger $everyMinute -Settings $checkSettings -Principal $principal -Description 'Controle de sante du PSIM' -Force | Out-Null
            } else {
                $plain = $cred.GetNetworkCredential().Password
                Register-ScheduledTask -TaskName $MainTask -Action $run -Trigger $boot -Settings $settings -User $User -Password $plain -RunLevel Limited -Description 'GAMRdigitale PSIM' -Force | Out-Null
                Register-ScheduledTask -TaskName $HealthTask -Action $checkAction -Trigger $everyMinute -Settings $checkSettings -User $User -Password $plain -RunLevel Limited -Description 'Controle de sante du PSIM' -Force | Out-Null
            }
            Start-ScheduledTask -TaskName $MainTask
            Write-Host "Installe. Le PSIM demarre maintenant et a chaque demarrage de la machine ; il est relance s'il s'arrete."
            Write-Host "Journaux : $(Join-Path $Root 'data\logs\psim.log')"
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
