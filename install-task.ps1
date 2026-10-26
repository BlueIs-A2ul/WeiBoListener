# Register a Windows scheduled task to start the Weibo listener at logon.
# Run as the current user. Administrator rights are usually not required.
# Usage: right-click "Run with PowerShell", or run .\install-task.ps1

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$vbs = Join-Path $root 'run-hidden.vbs'
$startBat = Join-Path $root 'start.bat'
$taskName = 'WeiBoListener'

if (-not (Test-Path $startBat)) {
    throw "Start script not found: $startBat"
}
if (-not (Test-Path $vbs)) {
    throw "Hidden launcher not found: $vbs"
}

$wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
if (-not (Test-Path $wscript)) {
    throw "wscript.exe not found: $wscript"
}

$action = New-ScheduledTaskAction `
    -Execute $wscript `
    -Argument "`"$vbs`"" `
    -WorkingDirectory $root `
    -ErrorAction Stop

$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser -ErrorAction Stop
$settings = New-ScheduledTaskSettingsSet `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -MultipleInstances IgnoreNew `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Days 0) `
    -ErrorAction Stop

Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description 'Weibo pending comment listener with WxPusher notifications' `
    -Force | Out-Null

Write-Host "Scheduled task created: $taskName"
Write-Host "Launcher: $vbs"
Write-Host "It will start automatically when $currentUser logs on."
Write-Host "You can view, run, or delete it in Task Scheduler."
