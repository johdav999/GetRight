param(
    [string]$RepositoryPath = (Join-Path (Split-Path $PSScriptRoot -Parent) '../WriterApp'),
    [ValidateRange(1024, 65535)][int]$Port = 5387
)
$ErrorActionPreference = 'Stop'
$getrightRoot = Split-Path $PSScriptRoot -Parent
$writerRoot = (Resolve-Path -LiteralPath $RepositoryPath).Path
if (-not (Test-Path -LiteralPath (Join-Path $writerRoot 'BlazorApp.csproj'))) { throw 'The selected folder is not a WriterApp checkout.' }
$instanceId = [Guid]::NewGuid().ToString('N')
$hostRoot = Join-Path $getrightRoot "data/writerapp/$instanceId"
[IO.Directory]::CreateDirectory($hostRoot) | Out-Null
$env:DOTNET_CLI_HOME = Join-Path $getrightRoot '.local/dotnet'
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
$days = [int]([DateTime]::UtcNow - [DateTime]'2020-01-01').TotalDays
$version = "0.1.$days.$(Get-Random -Minimum 1 -Maximum 65535)"
$relativeBuildRoot = "artifacts/getright/$instanceId"
$buildArguments = @("-p:BaseOutputPath=$relativeBuildRoot/bin/", "-p:BaseIntermediateOutputPath=$relativeBuildRoot/obj/", "-p:AssemblyVersion=$version", "-p:Version=$version")
Push-Location $writerRoot
try {
    # Each referenced project gets its own relative artifacts directory. No source
    # config is copied into the host: the isolated instance has its own database.
    & dotnet build BlazorApp.csproj @buildArguments
    if ($LASTEXITCODE -ne 0) { throw 'WriterApp build failed. No test instance was started.' }
    $outputRoot = Join-Path $writerRoot "$relativeBuildRoot/bin/Debug/net10.0"
    $assembly = Join-Path $outputRoot 'BlazorApp.dll'
    $manifest = Join-Path $outputRoot 'BlazorApp.staticwebassets.runtime.json'
    if (-not (Test-Path -LiteralPath $manifest)) { throw 'The WriterApp build did not produce its client static-assets manifest.' }
    $clientIndexRoot = Join-Path $hostRoot 'wwwroot/app'
    [IO.Directory]::CreateDirectory($clientIndexRoot) | Out-Null
    Copy-Item -LiteralPath (Join-Path $writerRoot 'WriterApp.Client/wwwroot/index.html') -Destination (Join-Path $clientIndexRoot 'index.html')
    $origin = "http://localhost:$Port"
    # WriterApp's Development handler deliberately uses this fixed identity.
    # Isolation comes from the new per-instance database, not DEV_AUTH_* overrides.
    $userId = 'dev-oid'
    $configuration = @{
        DatabaseProvider = 'Sqlite'
        ConnectionStrings = @{ DefaultConnection = "Data Source=$(Join-Path $hostRoot 'writerapp.db')" }
        UseExternalIdAuth = $false
        AppUrls = @{ PublicBaseUrl = $origin }
        Stripe = @{ Enabled = $false }
        WriterApp = @{
            Database = @{ AutoMigrateOnStartup = $true }
            Auth = @{ DevAutoLogin = $true; UseExternalIdAuth = $false }
            AI = @{ Enabled = $false }
            WasmClient = @{ Enabled = $true }
        }
        Workflow = @{ ProjectsEnabled = $false }
        Logging = @{ LogLevel = @{ Default = 'Warning'; 'Microsoft.Hosting.Lifetime' = 'Information' } }
    }
    $configuration | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $hostRoot 'appsettings.json') -Encoding utf8
    $commit = (& git rev-parse HEAD).Trim()
    $dirty = [bool](& git status --porcelain)
    @{
        applicationId = 'writerapp'; baseUrl = $origin; expectedBuildVersion = $version
        expectedUserId = $userId; isolatedDataConfirmed = $true
        sourceCommit = $commit; sourceWasDirty = $dirty; createdAt = [DateTimeOffset]::UtcNow.ToString('o')
        instanceId = $instanceId; authenticationMode = 'development-fixed-identity'
    } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $hostRoot 'build-receipt.json') -Encoding utf8
    $env:ASPNETCORE_ENVIRONMENT = 'Development'
    $env:DOTNET_ENVIRONMENT = 'Development'
    $env:ASPNETCORE_STATICWEBASSETS = $manifest
    # WriterApp re-adds environment configuration after its defaults. Pin the
    # isolation boundary here too, so inherited machine settings cannot select
    # a normal database, enable billing/AI, or start a collaboration service.
    $env:DatabaseProvider = 'Sqlite'
    $env:ConnectionStrings__DefaultConnection = "Data Source=$(Join-Path $hostRoot 'writerapp.db')"
    $env:WriterApp__Database__AutoMigrateOnStartup = 'true'
    $env:WriterApp__AI__Enabled = 'false'
    $env:Stripe__Enabled = 'false'
    $env:UseExternalIdAuth = 'false'
    $env:WriterApp__Auth__UseExternalIdAuth = 'false'
    $env:WriterApp__WasmClient__Enabled = 'true'
    $env:AppUrls__PublicBaseUrl = $origin
    $env:Collaboration__LocalTest__Enabled = 'false'
    $env:Collaboration__SessionsEnabled = 'false'
    $env:Collaboration__CommitsEnabled = 'false'
    $env:Collaboration__Sharing__Enabled = 'false'
    $env:MailGunAPIKey = ''
    Write-Output "WriterApp UAT instance: $origin"
    Write-Output "Expected build version: $version"
    Write-Output "Dedicated UAT account ID: $userId"
    Write-Output "Local receipt: $(Join-Path $hostRoot 'build-receipt.json')"
    & dotnet $assembly --contentRoot $hostRoot --urls $origin
    if ($LASTEXITCODE -ne 0) { throw "WriterApp exited with code $LASTEXITCODE" }
} finally { Pop-Location }
