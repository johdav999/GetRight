param([switch]$Headless, [switch]$Once, [switch]$AutoClose, [switch]$Background)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
if ($Background -and $Once) { throw 'Use -Once in the foreground; -Background starts a continuous worker.' }
if ($Headless) { $env:GETRIGHT_HEADLESS = 'true' }
Push-Location $projectRoot
try {
    $workerArguments = @((Join-Path $projectRoot 'worker/src/launch.mjs'))
    if ($Once) { $workerArguments += '--once' }
    if ($AutoClose) { $workerArguments += '--auto-close' }
    if ($Background) {
        $taskData = if ($env:GETRIGHT_DATA_PATH) { $env:GETRIGHT_DATA_PATH } else { Join-Path $projectRoot 'data' }
        $taskLogs = Join-Path $taskData ('worker-hosts/' + [Guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $taskLogs -Force | Out-Null
        $taskChild = Start-Process -FilePath (Get-Command node -ErrorAction Stop).Source -ArgumentList @($workerArguments | ForEach-Object { '"' + $_ + '"' }) -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $taskLogs 'stdout.log') -RedirectStandardError (Join-Path $taskLogs 'stderr.log') -PassThru
        Start-Sleep -Milliseconds 500
        $taskChild.Refresh()
        if ($taskChild.HasExited) { throw "Worker did not stay running. See $taskLogs." }
        @{ processId = $taskChild.Id; startedAt = [DateTimeOffset]::UtcNow.ToString('O'); logs = $taskLogs } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $taskLogs 'instance.json') -Encoding UTF8
        Write-Output "Getright worker started in the background (PID $($taskChild.Id)). Logs: $taskLogs"
        return
    }
    & node @workerArguments
    if ($LASTEXITCODE -ne 0) { throw "Worker exited with code $LASTEXITCODE" }
} finally { Pop-Location }
