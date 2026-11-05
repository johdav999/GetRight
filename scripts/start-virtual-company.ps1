param([string]$DashboardUrl = 'http://127.0.0.1:5120', [switch]$NoDashboardBuild)
$ErrorActionPreference = 'Stop'
$taskRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
# Reuse the guarded dashboard launcher: validate its origin/data directory and
# refuse unrelated listeners before creating any application worktree or host.
& (Join-Path $PSScriptRoot 'start-dashboard.ps1') -Url $DashboardUrl -Background -NoBuild:$NoDashboardBuild
$env:GETRIGHT_DASHBOARD_URL = $DashboardUrl
Push-Location $taskRoot
try { node worker/src/start-virtual-company.mjs; if ($LASTEXITCODE -ne 0) { throw 'Virtual Company UAT launcher failed. See the printed local logs.' } }
finally { Pop-Location }
