param([switch]$Headless, [switch]$Once)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
if ($Headless) { $env:GETRIGHT_HEADLESS = 'true' }
Push-Location $projectRoot
try {
    $workerArguments = @('worker/src/index.mjs')
    if ($Once) { $workerArguments += '--once' }
    & node @workerArguments
    if ($LASTEXITCODE -ne 0) { throw "Worker exited with code $LASTEXITCODE" }
} finally { Pop-Location }
