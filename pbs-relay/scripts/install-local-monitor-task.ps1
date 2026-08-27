param([string]$TaskName = 'TrafficReporter-PBS-LocalMonitor')

$ErrorActionPreference = 'Stop'
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($null -ne $existing) { throw "Scheduled task '$TaskName' already exists; refusing to overwrite it." }

$relayDirectory = Split-Path -Parent $PSScriptRoot
$monitorPath = Join-Path $relayDirectory 'src\localMonitor.js'
$nodePath = (Get-Command node -ErrorAction Stop).Source
$userId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute $nodePath -Argument ('"{0}" --watch' -f $monitorPath) -WorkingDirectory $relayDirectory
$logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
$watchdogTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration (New-TimeSpan -Days 3650)
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 5 `
  -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($logonTrigger, $watchdogTrigger) -Principal $principal `
  -Settings $settings -Description 'Windows-only PBS local edge monitor. No Cloudflare push.' | Out-Null
Get-ScheduledTask -TaskName $TaskName
