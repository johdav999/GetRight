# Shared local launcher helpers. No process is selected from a PID file alone.
function Get-GetrightSettings {
    param([string]$ProjectRoot, [string]$Url)
    if (-not $Url) { $Url = if ($env:ASPNETCORE_URLS) { $env:ASPNETCORE_URLS } else { 'http://127.0.0.1:5120' } }
    $taskUri = $null
    if (-not [Uri]::TryCreate($Url, [UriKind]::Absolute, [ref]$taskUri) -or $taskUri.Scheme -ne 'http' -or -not $taskUri.IsLoopback -or $taskUri.UserInfo -or $taskUri.AbsolutePath -ne '/' -or $taskUri.Query -or $taskUri.Fragment -or $taskUri.Port -lt 1) {
        throw 'Use a single loopback HTTP origin, such as -Url http://127.0.0.1:5120.'
    }
    $taskData = if ($env:Getright__DataPath) { $env:Getright__DataPath } else { Join-Path $ProjectRoot 'data' }
    if (-not [IO.Path]::IsPathRooted($taskData)) { $taskData = Join-Path $ProjectRoot $taskData }
    [pscustomobject]@{ Root = $ProjectRoot; Url = $taskUri.GetLeftPart([UriPartial]::Authority); HostName = $taskUri.DnsSafeHost; Port = $taskUri.Port; DataPath = [IO.Path]::GetFullPath($taskData); Exe = Join-Path $ProjectRoot 'src/Getright.Dashboard/bin/Release/net10.0/Getright.Dashboard.exe' }
}

function Get-GetrightHealth {
    param($Settings)
    try {
        $taskHealth = Invoke-RestMethod -Uri ($Settings.Url + '/api/health') -TimeoutSec 3 -MaximumRedirection 0
        if ($taskHealth.name -eq 'Getright' -and $taskHealth.mode -eq 'local' -and $taskHealth.version) { return $taskHealth }
    } catch { }
    return $null
}

function Test-GetrightPort {
    param($Settings)
    $taskClient = New-Object Net.Sockets.TcpClient
    try { $taskConnect = $taskClient.ConnectAsync($Settings.HostName, $Settings.Port); if ($taskConnect.Wait(1000)) { return $taskClient.Connected }; return $false }
    catch { return $false }
    finally { $taskClient.Dispose() }
}

function Assert-GetrightData {
    param($Settings, $Health)
    if ($Health.dataPath -and [IO.Path]::GetFullPath($Health.dataPath) -ne $Settings.DataPath) {
        throw "Getright is already running at $($Settings.Url) with a different data directory. Use that instance or choose a different -Url for this data."
    }
}

function Stop-GetrightInstance {
    param($Settings, $Health, [switch]$PreserveQueued)
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'Stop the foreground dashboard with Ctrl+C on this platform.' }
    Assert-GetrightData $Settings $Health
    $taskListeners = @(Get-NetTCPConnection -LocalPort $Settings.Port -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)
    if ($taskListeners.Count -ne 1) { throw 'Cannot identify one dashboard listener. No process was stopped.' }
    $taskProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$($taskListeners[0])"
    if (-not $taskProcess -or $taskProcess.ExecutablePath -ne $Settings.Exe -or ($Health.processId -and $Health.processId -ne $taskProcess.ProcessId)) {
        throw 'The listener is not this checkout''s dashboard process. No process was stopped.'
    }
    if (-not $Health.dataPath) {
        # Upgrade a verified legacy background instance created before health
        # reported its data directory. A stale file never authorizes a stop.
        $taskLegacyPath = Join-Path $Settings.Root '.local/dashboard-managed.json'
        if (-not (Test-Path -LiteralPath $taskLegacyPath)) { throw 'The older dashboard does not identify its data directory. Stop its foreground window with Ctrl+C, then start it again.' }
        $taskLegacy = Get-Content -LiteralPath $taskLegacyPath -Raw | ConvertFrom-Json
        if ($taskLegacy.ProcessId -ne $taskProcess.ProcessId -or $taskLegacy.ExecutablePath -ne $taskProcess.ExecutablePath -or $taskLegacy.DataPath -ne $Settings.DataPath) { throw 'Legacy dashboard ownership does not match. No process was stopped.' }
    }
    try { $taskActive = Invoke-RestMethod -Uri ($Settings.Url + '/api/operations/active') -TimeoutSec 3 -MaximumRedirection 0 }
    catch {
        if ($Health.instanceId) { throw 'Cannot verify active work. No process was stopped.' }
        $taskRuns = Invoke-RestMethod -Uri ($Settings.Url + '/api/runs') -TimeoutSec 3
        $taskJobs = Invoke-RestMethod -Uri ($Settings.Url + '/api/jobs') -TimeoutSec 3
        $taskCleanup = Invoke-RestMethod -Uri ($Settings.Url + '/api/maintenance/tasks') -TimeoutSec 3
        if ($taskRuns.Count -ge 100 -or $taskJobs.Count -ge 100 -or $taskCleanup.Count -ge 100) { throw 'The older dashboard cannot prove it is idle. Stop it manually after reviewing active work.' }
        $taskActive = [pscustomobject]@{
            runs = @($taskRuns | Where-Object { $_.status -in @('queued','running') }).Count
            jobs = @($taskJobs | Where-Object { $_.status -in @('queued','preparing','implementing','building','launching','rerunning') }).Count
            cleanup = @($taskCleanup | Where-Object { $_.status -in @('queued','running') }).Count
        }
    }
    if ($null -eq $taskActive.runs -or $null -eq $taskActive.jobs -or $null -eq $taskActive.cleanup) { throw 'Cannot verify active work. No process was stopped.' }
    if ($taskActive.runs -or $taskActive.jobs -or $taskActive.cleanup -or $taskActive.caseImplementations) {
        if (-not $PreserveQueued -or $taskActive.jobs -or $taskActive.cleanup) { throw 'Getright has queued or running work. Complete or cancel it in the dashboard before restarting or stopping.' }
        # Stop queue consumers before preserving a complete unclaimed inventory.
        $taskWorkerPattern = [regex]::Escape($Settings.Root) + '[\\/]worker[\\/]src[\\/](index|launch|run-child)\.mjs'
        $taskWorkers = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match $taskWorkerPattern })
        if ($taskWorkers.Count) { throw 'Stop this checkout''s workers before preserving queued work. No dashboard process was stopped.' }
        $taskRuns = Invoke-RestMethod -Uri ($Settings.Url + '/api/runs') -TimeoutSec 3 -MaximumRedirection 0
        $taskRuns = @($taskRuns)
        $taskPendingRuns = @($taskRuns | Where-Object { $_.status -in @('queued','running') })
        if ($taskPendingRuns.Count -ne $taskActive.runs -or @($taskPendingRuns | Where-Object { $_.status -ne 'queued' -or $_.improvementJobId -or $_.caseImplementationJobId }).Count) {
            throw 'Getright has queued or running work that cannot be preserved safely. Only fully inventoried, unclaimed standalone tests can be reloaded.'
        }
        $taskCases = Invoke-RestMethod -Uri ($Settings.Url + '/api/case-implementations') -TimeoutSec 3 -MaximumRedirection 0
        $taskCases = @($taskCases)
        $taskPending = @($taskCases | Where-Object { $_.status -eq 'queued' -or $_.status -in @('preparing','planning','building','implementing','validating') })
        if ($taskPending.Count -ne $taskActive.caseImplementations -or @($taskPending | Where-Object { $_.status -ne 'queued' }).Count) {
            throw 'Getright has queued or running work that cannot be preserved safely. Only a fully verified, unclaimed implementation queue can be reloaded.'
        }
        Write-Output "Preserving $($taskPending.Count) queued test implementations. Workers must remain stopped until the dashboard is ready."
        if ($taskPendingRuns.Count) { Write-Output "Preserving $($taskPendingRuns.Count) queued UAT tests with their existing run IDs." }
    }
    $taskCurrent = Get-GetrightHealth $Settings
    if (-not $taskCurrent -or $taskCurrent.instanceId -ne $Health.instanceId -or $taskCurrent.processId -ne $Health.processId) { throw 'The dashboard changed during the check. No process was stopped.' }
    Stop-Process -Id $taskProcess.ProcessId -ErrorAction Stop
    for ($taskAttempt = 0; $taskAttempt -lt 50; $taskAttempt++) {
        if (-not (Get-Process -Id $taskProcess.ProcessId -ErrorAction SilentlyContinue)) { return }
        Start-Sleep -Milliseconds 100
    }
    throw 'The verified dashboard did not stop. Check its process before retrying.'
}
