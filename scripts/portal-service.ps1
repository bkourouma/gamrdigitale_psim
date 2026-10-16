<#
.SYNOPSIS
  Demarrage automatique du PORTAIL de suivi a distance sous Windows (tache planifiee), avec relance apres arret.

.DESCRIPTION
  Cree la tache planifiee "PSIM-portail" : au demarrage de la machine, sous le compte de l'utilisateur COURANT, sans
  fenetre et meme sans session ouverte (S4U, comme le mode -Background de windows-service.ps1). Le portail garde les
  droits de ce compte, qui possede deja le dossier et portal-data : aucun droit nouveau.

  La tache lance ce meme script avec -Action Run : une boucle qui demarre le portail et le RELANCE s'il s'arrete
  (pause croissante 5 s, 10 s, 20 s... 60 s au plus, remise a 5 s apres 10 minutes de marche). Le « redemarrer si la
  tache echoue » de Windows ne relance pas un programme qui s'arrete apres avoir demarre.

  Windows exige un PowerShell OUVERT EN ADMINISTRATEUR pour INSTALLER (une seule fois) une tache qui demarre avec la
  machine. A lancer depuis le dossier du projet :

    .\scripts\portal-service.ps1 -Action Install      # installe et demarre (arrete d'abord un portail deja lance)
    .\scripts\portal-service.ps1 -Action Status
    .\scripts\portal-service.ps1 -Action Stop
    .\scripts\portal-service.ps1 -Action Start
    .\scripts\portal-service.ps1 -Action Restart
    .\scripts\portal-service.ps1 -Action Uninstall

  Configuration : .env.portal s'il existe (sinon port 4300, donnees portal-data). Journal : portal-data\portal.log.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Install', 'Uninstall', 'Status', 'Start', 'Stop', 'Restart', 'Run')]
    [string]$Action
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$TaskName = 'PSIM-portail'
# Tache ponctuelle qui a servi a relancer le portail a la main : remplacee par la tache permanente.
$OldTasks = @('PSIM-portail-lancement')
$LogFile = Join-Path $Root 'portal-data\portal.log'

function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    return ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-NodePath {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if (-not $cmd) { throw "Node.js est introuvable dans le PATH. Installez Node.js 24 ou plus." }
    return $cmd.Source
}

# Port du portail : PORTAL_PORT de .env.portal, sinon 4300.
function Get-PortalPort {
    $envPath = Join-Path $Root '.env.portal'
    if (Test-Path $envPath) {
        $line = Select-String -Path $envPath -Pattern '^\s*PORTAL_PORT=(\d+)' | Select-Object -First 1
        if ($line) { return [int]$line.Matches[0].Groups[1].Value }
    }
    return 4300
}

# Processus node du portail (celui qui ecoute sur le port), ou $null.
function Get-PortalPid {
    $conn = Get-NetTCPConnection -LocalPort (Get-PortalPort) -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $conn) { return $null }
    $proc = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
    if ($proc -and $proc.ProcessName -eq 'node') { return $conn.OwningProcess } else { return $null }
}

# Arret complet : la tache (donc la boucle), puis le portail s'il a survecu.
function Stop-Portal {
    foreach ($name in @($TaskName) + $OldTasks) { Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue }
    for ($i = 0; $i -lt 10 -and (Get-PortalPid); $i++) { Start-Sleep -Milliseconds 500 }
    $left = Get-PortalPid
    if ($left) {
        & taskkill.exe /PID $left /T /F | Out-Null
        Write-Host "Portail (processus $left) arrete."
    }
}

if ($Action -eq 'Install' -and -not $WhatIfPreference -and -not (Test-Admin)) {
    throw "Cette action demande un PowerShell ouvert en administrateur (clic droit > Executer en tant qu'administrateur)."
}

switch ($Action) {
    'Run' {
        $node = Get-NodePath
        $delay = 5
        Set-Location $Root
        while ($true) {
            $started = Get-Date
            Add-Content -Path $LogFile -Value "$($started.ToString('o')) [service] demarrage du portail"
            & cmd.exe /d /c "`"$node`" --env-file-if-exists=.env.portal portal/server/main.ts >> `"$LogFile`" 2>&1"
            $code = $LASTEXITCODE
            if (((Get-Date) - $started).TotalMinutes -ge 10) { $delay = 5 }
            Add-Content -Path $LogFile -Value "$((Get-Date).ToString('o')) [service] portail arrete (code $code), relance dans $delay s"
            Start-Sleep -Seconds $delay
            $delay = [Math]::Min($delay * 2, 60)
        }
    }
    'Install' {
        $null = Get-NodePath
        $me = [Security.Principal.WindowsIdentity]::GetCurrent().Name
        $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
        $run = New-ScheduledTaskAction -Execute $ps -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Action Run" -WorkingDirectory $Root
        $boot = New-ScheduledTaskTrigger -AtStartup
        $principal = New-ScheduledTaskPrincipal -UserId $me -LogonType S4U -RunLevel Limited
        $settings = New-ScheduledTaskSettingsSet `
            -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
            -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
            -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
            -MultipleInstances IgnoreNew
        if ($PSCmdlet.ShouldProcess($TaskName, "Creer la tache planifiee (dossier : $Root, compte : $me, arriere-plan)")) {
            Stop-Portal
            foreach ($name in $OldTasks) {
                if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $name -Confirm:$false; Write-Host "Ancienne tache $name supprimee." }
            }
            Register-ScheduledTask -TaskName $TaskName -Action $run -Trigger $boot -Settings $settings -Principal $principal -Description "GAMRdigitale portail de suivi (arriere-plan, relance automatique). Journal : $LogFile" -Force | Out-Null
            Start-ScheduledTask -TaskName $TaskName
            for ($i = 0; $i -lt 30 -and -not (Get-PortalPid); $i++) { Start-Sleep -Milliseconds 500 }
            Write-Host $(if (Get-PortalPid) { "Installe. Le portail repond sur le port $(Get-PortalPort) ; il demarre avec la machine et est relance s'il s'arrete." } else { "Installe, mais le portail ne repond pas encore : voir $LogFile." })
        }
    }
    'Uninstall' {
        foreach ($name in @($TaskName) + $OldTasks) {
            if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
                if ($PSCmdlet.ShouldProcess($name, 'Supprimer la tache planifiee')) {
                    Stop-Portal
                    Unregister-ScheduledTask -TaskName $name -Confirm:$false
                    Write-Host "Tache $name supprimee."
                }
            }
        }
        Write-Host 'Les donnees (portal-data\) ne sont pas touchees.'
    }
    'Start' { if ($PSCmdlet.ShouldProcess($TaskName, 'Demarrer')) { Start-ScheduledTask -TaskName $TaskName; Write-Host 'Demarre.' } }
    'Stop'  { if ($PSCmdlet.ShouldProcess($TaskName, 'Arreter')) { Stop-Portal; Write-Host 'Arrete (il redemarrera au prochain demarrage de la machine, ou par -Action Start).' } }
    'Restart' {
        if ($PSCmdlet.ShouldProcess($TaskName, 'Redemarrer')) {
            Stop-Portal
            Start-ScheduledTask -TaskName $TaskName
            for ($i = 0; $i -lt 30 -and -not (Get-PortalPid); $i++) { Start-Sleep -Milliseconds 500 }
            Write-Host $(if (Get-PortalPid) { "Redemarre (portail : processus $(Get-PortalPid))." } else { "Tache relancee, portail pas encore pret : voir $LogFile." })
        }
    }
    'Status' {
        foreach ($name in @($TaskName) + $OldTasks) {
            $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
            if (-not $task) { if ($name -eq $TaskName) { Write-Host ("{0,-24} non installee" -f $name) }; continue }
            $info = Get-ScheduledTaskInfo -TaskName $name
            Write-Host ("{0,-24} {1,-10} dernier resultat : {2} ; derniere execution : {3} ; compte : {4} ({5})" -f $name, $task.State, $info.LastTaskResult, $info.LastRunTime, $task.Principal.UserId, $task.Principal.LogonType)
        }
        $portalPid = Get-PortalPid
        Write-Host $(if ($portalPid) { "Portail en marche : processus $portalPid, port $(Get-PortalPort)." } else { 'Portail ARRETE.' })
    }
}
