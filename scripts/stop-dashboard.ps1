param([string]$Url)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
. (Join-Path $PSScriptRoot 'dashboard-instance.ps1')
$taskSettings = Get-GetrightSettings $projectRoot $Url
$taskHealth = Get-GetrightHealth $taskSettings
if (-not $taskHealth) {
    if (Test-GetrightPort $taskSettings) { throw 'The listener is not a healthy Getright dashboard. No process was stopped.' }
    Write-Output "No Getright dashboard is running at $($taskSettings.Url)."
    return
}
Stop-GetrightInstance $taskSettings $taskHealth
Write-Output "Getright stopped at $($taskSettings.Url). Run history and evidence are retained."
