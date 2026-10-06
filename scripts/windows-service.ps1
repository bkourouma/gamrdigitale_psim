<#
.SYNOPSIS
  Demarrage automatique du PSIM sous Windows, avec redemarrage apres panne (taches planifiees).

.DESCRIPTION
  Cree deux taches planifiees, sans logiciel supplementaire :
    - "PSIM"             : lance le SUPERVISEUR (scripts/supervise.ts) au demarrage de la machine ; c'est lui qui lance
                           le PSIM et le RELANCE en quelques secondes s'il s'arrete (plantage, processus tue) ou se bloque.
                           (Le « redemarrer si la tache echoue » de Windows ne relance PAS un programme qui s'arrete apres
                           avoir demarre : sans superviseur, un PSIM arrete le restait.)
    - "PSIM-healthcheck" : toutes les minutes, verifie /healthz ; apres 3 echecs consecutifs, arrete le PSIM bloque, et
                           relance la tache "PSIM" si plus rien ne tourne (superviseur compris).

  Trois modes :
    - SERVICE (par defaut) : demarre avec la machine, meme sans session ouverte, sous SYSTEM (ou un compte de service
      dedie) ; demande un PowerShell OUVERT EN ADMINISTRATEUR et un dossier non modifiable par les utilisateurs ordinaires.
    - -Background : sous le compte de l'utilisateur COURANT, demarre avec la machine, SANS FENETRE et meme sans session
      ouverte (fermer une fenetre ou se deconnecter ne l'arrete plus). Le PSIM garde les droits de ce compte, qui possede
      deja le dossier et les donnees : aucun droit nouveau. Windows exige tout de meme un PowerShell OUVERT EN
      ADMINISTRATEUR pour INSTALLER (une seule fois) une tache qui demarre avec la machine. A preferer sur un poste a un
      seul utilisateur.
    - -AtLogon : demarre a l'OUVERTURE DE SESSION de l'utilisateur courant, dans une fenetre visible. Fermer cette fenetre
      ou se deconnecter arrete la surveillance : a reserver aux essais.

  A lancer depuis le dossier du projet :

    .\scripts\windows-service.ps1 -Action Install            # installe et demarre
    .\scripts\windows-service.ps1 -Action Status             # etat
    .\scripts\windows-service.ps1 -Action Stop               # arrete (sans desinstaller)
    .\scripts\windows-service.ps1 -Action Start
    .\scripts\windows-service.ps1 -Action Restart            # arrete PROPREMENT (superviseur et PSIM) puis relance
    .\scripts\windows-service.ps1 -Action Uninstall          # retire les deux taches

  Ajouter -WhatIf pour VOIR ce qui serait fait sans rien modifier.

  Les journaux sont dans data\logs\psim.log (PSIM_LOG_FILE, actif par defaut en production).
  Avant d'installer : copier .env.example en .env, y mettre PSIM_ENV=production et vos mots de passe, puis
  verifier avec "npm run check-config".
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Install', 'Uninstall', 'Status', 'Start', 'Stop', 'Restart')]
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
    [switch]$AtLogon,

    # Mode arriere-plan : compte de l'utilisateur courant, au demarrage de la machine, sans fenetre ni session ouverte.
    [switch]$Background
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$MainTask = 'PSIM'
$HealthTask = 'PSIM-healthcheck'
# Installation de production (npm run init-production) : pas de .env, mais un .env.production. Sans cela, Status et Stop
# regarderaient le dossier « data » de demonstration et croiraient le PSIM arrete.
if (-not $PSBoundParameters.ContainsKey('EnvFile') -and -not (Test-Path (Join-Path $Root $EnvFile)) -and (Test-Path (Join-Path $Root '.env.production'))) { $EnvFile = '.env.production' }

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

# Dossier de donnees du fichier d'environnement (data-prod pour init-production), pas forcement "data".
function Get-DataDir {
    $dataDir = 'data'
    $envPath = Join-Path $Root $EnvFile
    if (Test-Path $envPath) {
        $line = Select-String -Path $envPath -Pattern '^\s*PSIM_DATA_DIR=(.+)$' | Select-Object -First 1
        if ($line) { $dataDir = $line.Matches[0].Groups[1].Value.Trim().Trim('"') }
    }
    if ([IO.Path]::IsPathRooted($dataDir)) { return $dataDir } else { return (Join-Path $Root $dataDir) }
}

# PSIM en cours (numero de processus ecrit dans psim.lock), ou $null.
function Get-PsimPid {
    $lock = Join-Path (Get-DataDir) 'psim.lock'
    if (-not (Test-Path $lock)) { return $null }
    $psimPid = 0
    if (-not [int]::TryParse((Get-Content $lock -Raw).Trim(), [ref]$psimPid)) { return $null }
    $proc = Get-Process -Id $psimPid -ErrorAction SilentlyContinue
    if ($proc -and $proc.ProcessName -eq 'node') { return $psimPid } else { return $null }
}

# Arret complet : la tache (donc le superviseur), puis le PSIM et ses ffmpeg s'il a survecu au superviseur.
# Sans cela, un ancien PSIM pouvait rester en vie et empecher le suivant de demarrer (« un autre PSIM utilise deja ce dossier »).
function Stop-Psim {
    Stop-ScheduledTask -TaskName $MainTask -ErrorAction SilentlyContinue
    for ($i = 0; $i -lt 10 -and (Get-PsimPid); $i++) { Start-Sleep -Milliseconds 500 }
    $left = Get-PsimPid
    if ($left) {
        & taskkill.exe /PID $left /T /F | Out-Null
        Write-Host "PSIM (processus $left) arrete."
    }
}

function Get-NodePath {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if (-not $cmd) { throw "Node.js est introuvable dans le PATH. Installez Node.js 24 ou plus." }
    return $cmd.Source
}

if ($AtLogon -and $Background) { throw "Choisir -AtLogon OU -Background, pas les deux." }
$UserMode = $AtLogon -or $Background
if ($Action -eq 'Install' -and -not $AtLogon -and -not $WhatIfPreference -and -not (Test-Admin)) {
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
        $me = [Security.Principal.WindowsIdentity]::GetCurrent().Name
        $principal = if ($AtLogon) {
            New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Limited
        } elseif ($Background) {
            # S4U : la tache tourne sous ce compte sans session ouverte ni fenetre, et sans que son mot de passe soit stocke.
            New-ScheduledTaskPrincipal -UserId $me -LogonType S4U -RunLevel Limited
        } elseif ($User -eq 'SYSTEM') {
            New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
        } else {
            $cred = Get-Credential -UserName $User -Message "Mot de passe du compte qui executera le PSIM"
            New-ScheduledTaskPrincipal -UserId $User -LogonType Password -RunLevel Limited
        }

        # --- Tache principale : le superviseur, au demarrage ; il lance le PSIM et le relance -------------------------
        $run = New-ScheduledTaskAction -Execute $node -Argument "--env-file=$EnvFile scripts/supervise.ts" -WorkingDirectory $Root
        $boot = if ($AtLogon) { New-ScheduledTaskTrigger -AtLogOn -User $me } else { New-ScheduledTaskTrigger -AtStartup }
        $settings = New-ScheduledTaskSettingsSet `
            -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
            -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
            -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
            -MultipleInstances IgnoreNew

        # --- Controle de sante : toutes les minutes, redemarre un PSIM bloque -------------------------------------
        $checkAction = New-ScheduledTaskAction -Execute $node -Argument "--env-file=$EnvFile scripts/healthcheck.ts --restart $HealthFailures --start-task $MainTask" -WorkingDirectory $Root
        $everyMinute = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Minutes 1)
        $checkSettings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 1) -StartWhenAvailable -MultipleInstances IgnoreNew

        $who = if ($AtLogon) { "$me, ouverture de session" } elseif ($Background) { "$me, arriere-plan sans fenetre" } else { $User }
        if ($PSCmdlet.ShouldProcess("$MainTask et $HealthTask", "Creer les taches planifiees (dossier : $Root, compte : $who)")) {
            # Une installation precedente tourne peut-etre (autre mode, PSIM lance directement) : on l'arrete d'abord.
            if (Get-ScheduledTask -TaskName $MainTask -ErrorAction SilentlyContinue) { Stop-Psim }
            if ($AtLogon) {
                Register-ScheduledTask -TaskName $MainTask -Action $run -Trigger $boot -Settings $settings -Principal $principal -Description 'GAMRdigitale PSIM (ouverture de session)' -Force | Out-Null
                Register-ScheduledTask -TaskName $HealthTask -Action $checkAction -Trigger $everyMinute -Settings $checkSettings -Principal $principal -Description 'Controle de sante du PSIM' -Force | Out-Null
            } elseif ($Background) {
                Register-ScheduledTask -TaskName $MainTask -Action $run -Trigger $boot -Settings $settings -Principal $principal -Description 'GAMRdigitale PSIM (arriere-plan, superviseur)' -Force | Out-Null
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
            Write-Host $(if ($AtLogon) { "Installe (mode ouverture de session). Le PSIM demarre maintenant et a chaque ouverture de session de $env:USERNAME ; il est relance s'il s'arrete. Ne fermez pas sa fenetre." } elseif ($Background) { "Installe (arriere-plan). Le PSIM demarre maintenant et a chaque demarrage de la machine, sans fenetre, meme sans session ouverte ; il est relance s'il s'arrete." } else { "Installe. Le PSIM demarre maintenant et a chaque demarrage de la machine ; il est relance s'il s'arrete." })
            Write-Host "Journaux : $(Join-Path (Get-DataDir) 'logs\psim.log')"
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
    'Stop'  { if ($PSCmdlet.ShouldProcess($MainTask, 'Arreter')) { Stop-Psim; Write-Host 'Arrete (il redemarrera au prochain demarrage de la machine, ou par -Action Start).' } }
    'Restart' {
        if ($PSCmdlet.ShouldProcess($MainTask, 'Redemarrer')) {
            Stop-Psim
            Start-ScheduledTask -TaskName $MainTask
            for ($i = 0; $i -lt 30 -and -not (Get-PsimPid); $i++) { Start-Sleep -Milliseconds 500 }
            if (Get-PsimPid) { Write-Host "Redemarre (PSIM : processus $(Get-PsimPid))." } else { Write-Host "Tache relancee, PSIM pas encore pret : voir $(Join-Path (Get-DataDir) 'logs\psim.log')." }
        }
    }
    'Status' {
        foreach ($name in $MainTask, $HealthTask) {
            $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
            if (-not $task) { Write-Host ("{0,-18} non installee" -f $name); continue }
            $info = Get-ScheduledTaskInfo -TaskName $name
            Write-Host ("{0,-18} {1,-10} dernier resultat : {2} ; derniere execution : {3} ; compte : {4} ({5})" -f $name, $task.State, $info.LastTaskResult, $info.LastRunTime, $task.Principal.UserId, $task.Principal.LogonType)
        }
        $psimPid = Get-PsimPid
        Write-Host $(if ($psimPid) { "PSIM en marche : processus $psimPid." } else { 'PSIM ARRETE.' })
    }
}
