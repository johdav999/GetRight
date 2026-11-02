param([switch]$NoBuild)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$env:DOTNET_CLI_HOME = Join-Path $projectRoot '.local/dotnet'
$env:NUGET_PACKAGES = Join-Path $projectRoot '.local/nuget'
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
if (-not $env:Getright__DataPath) { $env:Getright__DataPath = Join-Path $projectRoot 'data' }
Push-Location $projectRoot
try {
    $runArguments = @('run', '--project', 'src/Getright.Dashboard', '--configuration', 'Release', '--no-launch-profile')
    if ($NoBuild) { $runArguments += '--no-build' }
    & dotnet @runArguments
    if ($LASTEXITCODE -ne 0) { throw "Dashboard exited with code $LASTEXITCODE" }
} finally { Pop-Location }
