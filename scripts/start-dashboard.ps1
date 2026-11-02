param([switch]$NoBuild, [switch]$Restart, [switch]$Background, [switch]$PreserveQueued, [string]$Url)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
if ($PreserveQueued -and -not $Restart) { throw '-PreserveQueued requires -Restart. Stop workers before preserving a queued implementation batch.' }
. (Join-Path $PSScriptRoot 'dashboard-instance.ps1')
$taskSettings = Get-GetrightSettings $projectRoot $Url
$taskHealth = Get-GetrightHealth $taskSettings
if ($taskHealth) {
    Assert-GetrightData $taskSettings $taskHealth
    if (-not $Restart) {
        Write-Output "Getright is already running at $($taskSettings.Url). Use -Restart to rebuild and reload it."
        return
    }
    Stop-GetrightInstance $taskSettings $taskHealth -PreserveQueued:$PreserveQueued
} elseif (Test-GetrightPort $taskSettings) {
    throw "Port $($taskSettings.Port) is already in use and is not a healthy Getright dashboard. No process was stopped. Choose a different -Url or inspect that listener."
}
$env:DOTNET_CLI_HOME = Join-Path $projectRoot '.local/dotnet'
$env:NUGET_PACKAGES = Join-Path $projectRoot '.local/nuget'
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
$env:Getright__DataPath = $taskSettings.DataPath
Push-Location $projectRoot
try {
    if (-not $NoBuild) {
        & dotnet build Getright.sln --configuration Release
        if ($LASTEXITCODE -ne 0) { throw "Dashboard build failed with code $LASTEXITCODE. See the build output above." }
    }
    if (-not (Test-Path -LiteralPath $taskSettings.Exe)) { throw 'Dashboard build not found. Run this script without -NoBuild first.' }
    if ($Background) {
        New-Item -ItemType Directory -Path $taskSettings.DataPath -Force | Out-Null
        $taskLogs = Join-Path $taskSettings.DataPath ('dashboard-hosts/' + [Guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $taskLogs -Force | Out-Null
        $taskStdout = Join-Path $taskLogs 'stdout.log'
        $taskStderr = Join-Path $taskLogs 'stderr.log'
        $taskChild = Start-Process -FilePath $taskSettings.Exe -ArgumentList @('--urls', $taskSettings.Url) -WorkingDirectory (Join-Path $projectRoot 'src/Getright.Dashboard') -WindowStyle Hidden -RedirectStandardOutput $taskStdout -RedirectStandardError $taskStderr -PassThru
        for ($taskAttempt = 0; $taskAttempt -lt 100; $taskAttempt++) {
            $taskChild.Refresh()
            if ($taskChild.HasExited) { throw "Dashboard did not start. See $taskStderr and $taskStdout." }
            $taskStarted = Get-GetrightHealth $taskSettings
            if ($taskStarted -and $taskStarted.processId -eq $taskChild.Id) {
                Assert-GetrightData $taskSettings $taskStarted
                Write-Output "Getright started in the background at $($taskSettings.Url). Stop it with scripts/stop-dashboard.ps1."
                return
            }
            Start-Sleep -Milliseconds 200
        }
        # Stop only the exact child created by this invocation on failed readiness.
        if (-not $taskChild.HasExited) { $taskChild.Kill(); $taskChild.WaitForExit() }
        throw "Dashboard did not become ready. See $taskStderr and $taskStdout."
    }
    Write-Output "Getright: $($taskSettings.Url). Ctrl+C stops this foreground instance."
    & $taskSettings.Exe --urls $taskSettings.Url
    if ($LASTEXITCODE -ne 0) { throw "Dashboard exited with code $LASTEXITCODE" }
} finally { Pop-Location }
