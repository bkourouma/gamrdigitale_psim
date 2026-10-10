<#
.SYNOPSIS
  Demarrage automatique de la Passerelle GAMR sous Windows, avec relance apres panne (taches planifiees).

.DESCRIPTION
  Meme modele et meme durcissement que scripts\windows-service.ps1 (PSIM). Cree deux taches planifiees :
    - "GAMR-Passerelle"          : lance le SUPERVISEUR de la passerelle (gateway\src\supervise.ts) au demarrage de la
                                   machine ; il lance la passerelle et la RELANCE si elle s'arrete ou se bloque (fichier
                                   d'etat status.json plus mis a jour).
    - "GAMR-Passerelle-controle" : toutes les 5 minutes, relance la tache principale si elle ne tourne plus (filet de
                                   securite si le superviseur lui-meme a disparu).

  Les messages acceptes par la passerelle sont sur DISQUE (file d'envoi) : un arret, un plantage ou une coupure de courant
  ne les perd pas, ils repartent au redemarrage.

  Trois modes (comme le PSIM) :
    - SERVICE (par defaut) : au demarrage de la machine, meme sans session ouverte, sous SYSTEM (ou un compte dedie) ;
      PowerShell OUVERT EN ADMINISTRATEUR et dossier non modifiable par les utilisateurs ordinaires.
    - -Background : compte de l'utilisateur COURANT, au demarrage de la machine, sans fenetre ni session ouverte
      (installation en administrateur, une seule fois).
    - -AtLogon : a l'ouverture de session de l'utilisateur courant, fenetre visible. Reserve aux essais.

  A lancer depuis le dossier du projet :

    .\scripts\gateway-service.ps1 -Action Install                          # installe et demarre (gateway\config.json)
    .\scripts\gateway-service.ps1 -Action Install -Config C:\gamr\gw.json  # autre fichier de configuration
    .\scripts\gateway-service.ps1 -Action Status                           # etat (taches, PSIM joint ?, file d'envoi, modules)
    .\scripts\gateway-service.ps1 -Action Stop                             # arrete (sans desinstaller)
    .\scripts\gateway-service.ps1 -Action Start
    .\scripts\gateway-service.ps1 -Action Restart
    .\scripts\gateway-service.ps1 -Action Uninstall                        # retire les deux taches (la file est gardee)

  Ajouter -WhatIf pour VOIR ce qui serait fait sans rien modifier.
  Avant d'installer : creer la configuration (voir docs\PASSERELLE.md) puis verifier avec "npm run gateway:check-config".
  Journaux : <dossier de donnees>\logs\gateway.log
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Install', 'Uninstall', 'Status', 'Start', 'Stop', 'Restart')]
    [string]$Action,

    # Fichier de configuration de la passerelle (relatif au dossier du projet, ou absolu).
    [string]$Config = 'gateway\config.json',

    # Compte qui execute la passerelle. Par defaut SYSTEM ; preferer un compte de service dedie, a droits limites.
    [string]$User = 'SYSTEM',

    # Installer malgre un dossier modifiable par des utilisateurs ordinaires (deconseille : voir l'avertissement).
    [switch]$AllowWritableTree,

    # Mode poste ordinaire : tache de l'utilisateur courant, lancee a l'ouverture de session, sans administrateur.
    [switch]$AtLogon,

    # Mode arriere-plan : compte de l'utilisateur courant, au demarrage de la machine, sans fenetre ni session ouverte.
    [switch]$Background
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$MainTask = 'GAMR-Passerelle'
$WatchTask = 'GAMR-Passerelle-controle'
$ConfigPath = if ([IO.Path]::IsPathRooted($Config)) { $Config } else { Join-Path $Root $Config }

function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    return ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# Une passerelle lancee en SYSTEM depuis un dossier que n'importe quel utilisateur local peut modifier = execution de code en
# SYSTEM pour tout compte local (il suffit de changer gateway\*.ts, node_modules, ou la configuration). On refuse tant que ce
# n'est pas corrige. (Fonction identique a celle de windows-service.ps1, verifiee par test\windows-scripts.test.ts.)
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

# Un fichier secret LISIBLE par les utilisateurs ordinaires : avertissement (le mot de passe de la passerelle serait expose).
function Get-ReadableByOrdinaryUsers {
    param([string]$Path)
    $risky = @('S-1-1-0', 'S-1-5-11', 'S-1-5-32-545')
    if (-not (Test-Path $Path)) { return $false }
    foreach ($rule in (Get-Acl $Path).Access) {
        if ($rule.AccessControlType -ne 'Allow') { continue }
        try { $sid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value } catch { continue }
        if (($risky -contains $sid) -and ((([int]$rule.FileSystemRights) -band 0x80000001) -ne 0)) { return $true }   # lecture des donnees, lecture generique
    }
    return $false
}

# Lit la configuration (sans la valider : c'est le role de "npm run gateway:check-config").
function Get-GatewayConfig {
    if (-not (Test-Path $ConfigPath)) { return $null }
    try { return (Get-Content $ConfigPath -Raw | ConvertFrom-Json) } catch { return $null }
}

# Dossier de donnees de la passerelle (dataDir de la configuration, relatif au dossier du fichier ; "data" par defaut).
function Get-DataDir {
    $cfg = Get-GatewayConfig
    $dir = 'data'
    if ($cfg -and $cfg.dataDir) { $dir = [string]$cfg.dataDir }
    if ([IO.Path]::IsPathRooted($dir)) { return $dir } else { return (Join-Path (Split-Path -Parent $ConfigPath) $dir) }
}

# Passerelle en cours (numero de processus ecrit dans gateway.lock), ou $null.
function Get-GatewayPid {
    $lock = Join-Path (Get-DataDir) 'gateway.lock'
    if (-not (Test-Path $lock)) { return $null }
    $gwPid = 0
    if (-not [int]::TryParse((Get-Content $lock -Raw).Trim(), [ref]$gwPid)) { return $null }
    $proc = Get-Process -Id $gwPid -ErrorAction SilentlyContinue
    if ($proc -and $proc.ProcessName -eq 'node') { return $gwPid } else { return $null }
}

# Arret complet : la tache (donc le superviseur), puis la passerelle si elle a survecu au superviseur.
function Stop-Gateway {
    Stop-ScheduledTask -TaskName $MainTask -ErrorAction SilentlyContinue
    for ($i = 0; $i -lt 20 -and (Get-GatewayPid); $i++) { Start-Sleep -Milliseconds 500 }
    $left = Get-GatewayPid
    if ($left) {
        & taskkill.exe /PID $left /T /F | Out-Null
        Write-Host "Passerelle (processus $left) arretee. Sa file d'envoi est intacte sur disque."
    }
}

function Get-NodePath {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if (-not $cmd) { throw "Node.js est introuvable dans le PATH. Installez Node.js 24 ou plus." }
    return $cmd.Source
}

if ($AtLogon -and $Background) { throw "Choisir -AtLogon OU -Background, pas les deux." }
if ($Action -eq 'Install' -and -not $AtLogon -and -not $WhatIfPreference -and -not (Test-Admin)) {
    throw "Cette action demande un PowerShell ouvert en administrateur (clic droit > Executer en tant qu'administrateur)."
}

switch ($Action) {
    'Install' {
        $node = Get-NodePath
        if (-not (Test-Path $ConfigPath)) {
            throw "Configuration introuvable : $ConfigPath. Copiez gateway\config.example.json en gateway\config.json et adaptez-la (docs\PASSERELLE.md)."
        }
        # Verification complete AVANT d'installer : une configuration invalide ferait tourner la tache en boucle sans rien faire.
        if (-not $WhatIfPreference) {
            Push-Location $Root
            try {
                & $node '--env-file-if-exists=gateway/.env' 'gateway/src/main.ts' '--check' $ConfigPath
                $code = $LASTEXITCODE
            } finally { Pop-Location }
            if ($code -eq 2) { throw "Configuration invalide (voir ci-dessus) : installation annulee." }
            if ($code -ne 0) { Write-Warning "Le PSIM n'est pas joignable pour l'instant : la passerelle gardera les messages sur disque et les enverra des son retour." }
        }
        $configDir = Split-Path -Parent $ConfigPath
        $writable = Get-WritableByOrdinaryUsers -Paths @($Root, (Join-Path $Root 'gateway'), (Join-Path $Root 'scripts'), (Join-Path $Root 'node_modules'), $configDir, $ConfigPath)
        if ($writable.Count -gt 0 -and -not $AllowWritableTree) {
            throw ("Le dossier de la passerelle (ou sa configuration) est MODIFIABLE par des utilisateurs ordinaires :`n  " + ($writable -join "`n  ") + "`nUne passerelle lancee par une tache planifiee executerait leur code avec les droits du compte de service (et une configuration modifiee peut lui faire lire n'importe quel fichier). Corrigez les droits, par exemple (PowerShell administrateur ; ATTENTION : cela retire l'ecriture aux utilisateurs ordinaires, vous compris si vous n'etes pas administrateur) :`n  icacls `"$Root`" /inheritance:r /grant:r `"*S-1-5-18:(OI)(CI)F`" `"*S-1-5-32-544:(OI)(CI)F`" `"*S-1-5-32-545:(OI)(CI)RX`"`npuis donnez au compte de service le droit d'ECRIRE dans le seul dossier de donnees. (-AllowWritableTree pour passer outre, deconseille.)")
        }
        $cfg = Get-GatewayConfig
        if ($cfg -and $cfg.psim -and $cfg.psim.passwordFile) {
            $pw = [string]$cfg.psim.passwordFile
            $pwPath = if ([IO.Path]::IsPathRooted($pw)) { $pw } else { Join-Path $configDir $pw }
            if (Get-ReadableByOrdinaryUsers -Path $pwPath) { Write-Warning "Le fichier du mot de passe ($pwPath) est LISIBLE par les utilisateurs ordinaires : restreignez-le (icacls `"$pwPath`" /inheritance:r /grant:r `"*S-1-5-18:F`" `"*S-1-5-32-544:F`")." }
        }
        if ($cfg -and $cfg.psim -and $cfg.psim.password) { Write-Warning "Mot de passe ecrit en clair dans la configuration : preferez psim.passwordFile (fichier lisible des seuls administrateurs)." }

        $me = [Security.Principal.WindowsIdentity]::GetCurrent().Name
        $principal = if ($AtLogon) {
            New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Limited
        } elseif ($Background) {
            # S4U : la tache tourne sous ce compte sans session ouverte ni fenetre, et sans que son mot de passe soit stocke.
            New-ScheduledTaskPrincipal -UserId $me -LogonType S4U -RunLevel Limited
        } elseif ($User -eq 'SYSTEM') {
            New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
        } else {
            $cred = Get-Credential -UserName $User -Message "Mot de passe du compte qui executera la passerelle"
            New-ScheduledTaskPrincipal -UserId $User -LogonType Password -RunLevel Limited
        }

        # --- Tache principale : le superviseur, au demarrage ; il lance la passerelle et la relance --------------------
        $run = New-ScheduledTaskAction -Execute $node -Argument "--env-file-if-exists=gateway/.env gateway/src/supervise.ts `"$ConfigPath`"" -WorkingDirectory $Root
        $boot = if ($AtLogon) { New-ScheduledTaskTrigger -AtLogOn -User $me } else { New-ScheduledTaskTrigger -AtStartup }
        $settings = New-ScheduledTaskSettingsSet `
            -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
            -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
            -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
            -MultipleInstances IgnoreNew

        # --- Controle : toutes les 5 minutes, relance la tache principale si elle ne tourne plus ---------------------
        $watchCmd = "if ((Get-ScheduledTask -TaskName '$MainTask').State -ne 'Running') { Start-ScheduledTask -TaskName '$MainTask' }"
        $watchAction = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -Command `"$watchCmd`""
        $every5 = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(5) -RepetitionInterval (New-TimeSpan -Minutes 5)
        $watchSettings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 1) -StartWhenAvailable -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

        $who = if ($AtLogon) { "$me, ouverture de session" } elseif ($Background) { "$me, arriere-plan sans fenetre" } else { $User }
        if ($PSCmdlet.ShouldProcess("$MainTask et $WatchTask", "Creer les taches planifiees (dossier : $Root, configuration : $ConfigPath, compte : $who)")) {
            if (Get-ScheduledTask -TaskName $MainTask -ErrorAction SilentlyContinue) { Stop-Gateway }
            if ($AtLogon -or $Background -or $User -eq 'SYSTEM') {
                Register-ScheduledTask -TaskName $MainTask -Action $run -Trigger $boot -Settings $settings -Principal $principal -Description 'Passerelle GAMR (superviseur)' -Force | Out-Null
                Register-ScheduledTask -TaskName $WatchTask -Action $watchAction -Trigger $every5 -Settings $watchSettings -Principal $principal -Description 'Controle de la Passerelle GAMR' -Force | Out-Null
            } else {
                $plain = $cred.GetNetworkCredential().Password
                Register-ScheduledTask -TaskName $MainTask -Action $run -Trigger $boot -Settings $settings -User $User -Password $plain -RunLevel Limited -Description 'Passerelle GAMR (superviseur)' -Force | Out-Null
                Register-ScheduledTask -TaskName $WatchTask -Action $watchAction -Trigger $every5 -Settings $watchSettings -User $User -Password $plain -RunLevel Limited -Description 'Controle de la Passerelle GAMR' -Force | Out-Null
            }
            Start-ScheduledTask -TaskName $MainTask
            Write-Host $(if ($AtLogon) { "Installee (mode ouverture de session). Ne fermez pas sa fenetre." } elseif ($Background) { "Installee (arriere-plan). La passerelle demarre maintenant et a chaque demarrage de la machine, sans fenetre ; elle est relancee si elle s'arrete." } else { "Installee. La passerelle demarre maintenant et a chaque demarrage de la machine ; elle est relancee si elle s'arrete." })
            Write-Host "Journaux : $(Join-Path (Get-DataDir) 'logs\gateway.log')"
        }
    }
    'Uninstall' {
        foreach ($name in $MainTask, $WatchTask) {
            if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
                if ($PSCmdlet.ShouldProcess($name, 'Supprimer la tache planifiee')) {
                    if ($name -eq $MainTask) { Stop-Gateway } else { Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue }
                    Unregister-ScheduledTask -TaskName $name -Confirm:$false
                    Write-Host "Tache $name supprimee."
                }
            } else {
                Write-Host "Tache $name : absente."
            }
        }
        Write-Host "Les donnees (file d'envoi, journaux : $(Get-DataDir)) ne sont pas touchees."
    }
    'Start' {
        if ($PSCmdlet.ShouldProcess($MainTask, 'Demarrer')) {
            Enable-ScheduledTask -TaskName $WatchTask -ErrorAction SilentlyContinue | Out-Null
            Start-ScheduledTask -TaskName $MainTask
            Write-Host 'Demarree.'
        }
    }
    'Stop' {
        if ($PSCmdlet.ShouldProcess($MainTask, 'Arreter')) {
            # Le controle est suspendu, sinon il relancerait la passerelle dans les 5 minutes.
            Disable-ScheduledTask -TaskName $WatchTask -ErrorAction SilentlyContinue | Out-Null
            Stop-Gateway
            Write-Host "Arretee (elle redemarrera au prochain demarrage de la machine, ou par -Action Start). Les messages en attente sont gardes sur disque."
        }
    }
    'Restart' {
        if ($PSCmdlet.ShouldProcess($MainTask, 'Redemarrer')) {
            Stop-Gateway
            Enable-ScheduledTask -TaskName $WatchTask -ErrorAction SilentlyContinue | Out-Null
            Start-ScheduledTask -TaskName $MainTask
            for ($i = 0; $i -lt 30 -and -not (Get-GatewayPid); $i++) { Start-Sleep -Milliseconds 500 }
            if (Get-GatewayPid) { Write-Host "Redemarree (passerelle : processus $(Get-GatewayPid))." } else { Write-Host "Tache relancee, passerelle pas encore prete : voir $(Join-Path (Get-DataDir) 'logs\gateway.log')." }
        }
    }
    'Status' {
        foreach ($name in $MainTask, $WatchTask) {
            $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
            if (-not $task) { Write-Host ("{0,-26} non installee" -f $name); continue }
            $info = Get-ScheduledTaskInfo -TaskName $name
            Write-Host ("{0,-26} {1,-10} dernier resultat : {2} ; derniere execution : {3} ; compte : {4} ({5})" -f $name, $task.State, $info.LastTaskResult, $info.LastRunTime, $task.Principal.UserId, $task.Principal.LogonType)
        }
        $gwPid = Get-GatewayPid
        Write-Host $(if ($gwPid) { "Passerelle en marche : processus $gwPid." } else { 'Passerelle ARRETEE.' })
        $statusFile = Join-Path (Get-DataDir) 'status.json'
        if (Test-Path $statusFile) {
            try {
                $s = Get-Content $statusFile -Raw | ConvertFrom-Json
                $age = [math]::Round((((Get-Date).ToUniversalTime() - [DateTime]'1970-01-01').TotalMilliseconds - $s.at) / 1000)
                Write-Host ("Etat ecrit il y a {0} s ; PSIM {1} : {2}" -f $age, $s.psim.url, $(if ($s.psim.connected) { 'connecte' } else { 'NON CONNECTE' }))
                Write-Host ("File d'envoi : {0} message(s) en attente ; {1} abandonne(s) (file pleine) ; {2} refuse(s) par le PSIM" -f $s.queue.pending, $s.queue.dropped, $s.queue.rejected)
                foreach ($m in $s.modules) { Write-Host ("  module {0,-20} {1,-9} echecs : {2} {3}" -f $m.label, $m.state, $m.failures, $(if ($m.lastError) { "($($m.lastError))" } else { '' })) }
            } catch { Write-Host "Etat illisible : $statusFile" }
        }
    }
}
