# Remove the Windows scheduled task created by install-task.ps1.
# Usage: right-click "Run with PowerShell", or run .\uninstall-task.ps1

$ErrorActionPreference = 'Stop'
$taskName = 'WeiBoListener'

$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($null -eq $task) {
    Write-Host "Scheduled task not found: $taskName"
    exit 0
}

if ($task.State -eq 'Running') {
    Stop-ScheduledTask -TaskName $taskName
    Write-Host "Stopped running task: $taskName"
}

Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
Write-Host "Scheduled task removed: $taskName"
