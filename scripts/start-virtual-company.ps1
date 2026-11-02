param([string]$DashboardUrl = 'http://127.0.0.1:5120')
$ErrorActionPreference = 'Stop'
$taskRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$env:GETRIGHT_DASHBOARD_URL = $DashboardUrl
Push-Location $taskRoot
try { node worker/src/start-virtual-company.mjs; if ($LASTEXITCODE -ne 0) { throw 'Virtual Company UAT launcher failed. See the printed local logs.' } }
finally { Pop-Location }
