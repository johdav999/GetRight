using System.Net;
using System.Text.Json;

namespace Getright.Dashboard;

public record IdentityPreview(string Name, string Subject, string Mode);
public record CapabilityPreview(string Name, string State, string Detail);
public record ApplicationPreview(ApplicationReadiness Readiness, string? BaseUrl, string? ExpectedBuild,
    IdentityPreview[] Identities, string FixtureAdapter, FixtureRecipe[] Fixtures, CapabilityPreview[] Capabilities,
    string? Scope = null, string? Role = null);

public sealed class ApplicationSetup(RunStore store, ILogger<ApplicationSetup> logger)
{
    public static void Validate(ApplicationProfile profile, ApplicationManifest manifest)
    {
        if (profile.ApplicationId != manifest.ApplicationId || !ApplicationManifests.NeedsTarget(manifest)) throw new ArgumentException("Unknown application setup.");
        if (ApplicationManifests.Scoped(manifest) && (!Guid.TryParse(profile.ExpectedCompanyId, out _) || profile.ExpectedRole != "owner"))
            throw new ArgumentException("Virtual Company requires the isolated reference company ID and owner role from its launch receipt.");
        if (ApplicationManifests.IsConfiguredTarget(manifest) && (profile.ExpectedCompanyId is not null || profile.ExpectedRole is not null))
            throw new ArgumentException("This configured target uses an unscoped test account.");
        if (!Uri.TryCreate(profile.BaseUrl, UriKind.Absolute, out var url) || url.Scheme != "http" ||
            !url.IsLoopback || url.UserInfo != "" || url.AbsolutePath != "/" || url.Query != "" || url.Fragment != "" ||
            !(url.Host.Equals("localhost", StringComparison.OrdinalIgnoreCase) ||
              (IPAddress.TryParse(url.Host.Trim('[', ']'), out var address) && IPAddress.IsLoopback(address))))
            throw new ArgumentException("Use a loopback HTTP origin, such as http://localhost:5387, without a path or credentials.");
        if (string.IsNullOrWhiteSpace(profile.ExpectedBuildVersion) || profile.ExpectedBuildVersion.Length > 150 ||
            string.IsNullOrWhiteSpace(profile.ExpectedUserId) || profile.ExpectedUserId.Length > 150)
            throw new ArgumentException("Provide the expected running build version and dedicated UAT account ID (up to 150 characters each).");
        if (!profile.IsolatedDataConfirmed) throw new ArgumentException("Confirm that this instance uses isolated UAT data before enabling it.");
        if (profile.BuildReceipt is { } receipt && (!receipt.ValidFor(null) || !JobStates.Hash(profile.SourceCommit) || profile.SourceWasDirty))
            throw new ArgumentException("A build receipt needs a valid recipe, sealed artifact and clean source commit.");
        if (profile.SourceCommit is not null && !System.Text.RegularExpressions.Regex.IsMatch(profile.SourceCommit, "^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$"))
            throw new ArgumentException("The source revision must be a Git commit hash when supplied.");
    }

    public async Task<ApplicationReadiness> Check(string applicationId, CancellationToken cancellationToken = default)
    {
        var profile = store.Profile(applicationId);
        if (profile is null) return new(false, "Configure the local application instance first.");
        return await Check(profile, store.Manifests.Get(applicationId), cancellationToken);
    }
    private async Task<ApplicationReadiness> Check(ApplicationProfile profile, ApplicationManifest manifest, CancellationToken cancellationToken)
    {
        Validate(profile, manifest);
        using var client = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false, UseProxy = false })
            { BaseAddress = new Uri(profile.BaseUrl), Timeout = TimeSpan.FromSeconds(5) };
        try
        {
            if (manifest.Runtime is { } runtime)
            {
                await RuntimeConfiguration.Check(runtime, profile, cancellationToken);
                return new(true, "Ready: configured runtime and dedicated test identities match.", profile.ExpectedBuildVersion);
            }
            if (ApplicationManifests.Scoped(manifest))
            {
                using var response = await client.GetAsync("/_getright/runtime", cancellationToken);
                if (!response.IsSuccessStatusCode) return new(false, "Virtual Company UAT runtime is unavailable.");
                using var document = await JsonDocument.ParseAsync(await response.Content.ReadAsStreamAsync(cancellationToken), cancellationToken: cancellationToken);
                var root = document.RootElement;
                bool Match(string key, string? expected) => root.ValueKind == JsonValueKind.Object && root.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.String && value.GetString() == expected;
                if (!Match("version", profile.ExpectedBuildVersion) || !Match("userId", profile.ExpectedUserId) ||
                    !Match("companyId", profile.ExpectedCompanyId) || !Match("role", profile.ExpectedRole) ||
                    !root.TryGetProperty("isolated", out var isolated) || isolated.ValueKind != JsonValueKind.True)
                    return new(false, "Virtual Company build, owner, reference company or isolation does not match. No test data was created.");
                return new(true, "Ready: isolated Virtual Company build, company and owner match.", profile.ExpectedBuildVersion);
            }
            using var versionResponse = await client.GetAsync("/api/app/version", cancellationToken);
            if (!versionResponse.IsSuccessStatusCode) return new(false, "WriterApp did not return its build version. Check the local instance and sign-in setup.");
            using var version = await JsonDocument.ParseAsync(await versionResponse.Content.ReadAsStreamAsync(cancellationToken), cancellationToken: cancellationToken);
            if (version.RootElement.ValueKind != JsonValueKind.Object) return new(false, "WriterApp did not return a valid build-version response.");
            var running = version.RootElement.TryGetProperty("version", out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;
            if (running != profile.ExpectedBuildVersion) return new(false, "The running build does not match the expected version. Start the intended build or update setup.", running);
            using var authResponse = await client.GetAsync("/api/auth/me", cancellationToken);
            if (!authResponse.IsSuccessStatusCode) return new(false, "The dedicated UAT account is unavailable. Start an isolated development instance with automatic test sign-in.", running);
            using var auth = await JsonDocument.ParseAsync(await authResponse.Content.ReadAsStreamAsync(cancellationToken), cancellationToken: cancellationToken);
            if (auth.RootElement.ValueKind != JsonValueKind.Object) return new(false, "WriterApp did not return a valid account response.", running);
            if (!auth.RootElement.TryGetProperty("isAuthenticated", out var authenticated) || authenticated.ValueKind != JsonValueKind.True ||
                !auth.RootElement.TryGetProperty("userId", out var user) || user.ValueKind != JsonValueKind.String || user.GetString() != profile.ExpectedUserId)
                return new(false, "WriterApp is not signed in as the configured UAT account. No test data was created.", running);
            return new(true, "Ready: the local build and dedicated UAT account match.", running);
        }
        catch (InvalidOperationException exception) when (manifest.Runtime is not null)
        {
            return new(false, exception.Message);
        }
        catch (Exception exception) when (exception is HttpRequestException or TaskCanceledException or JsonException)
        {
            cancellationToken.ThrowIfCancellationRequested();
            logger.LogWarning("{Application} readiness failed: {FailureType}: {Detail}", profile.ApplicationId, exception.GetType().Name, exception.Message);
            return new(false, "Cannot verify the local application instance. Check that it is running and returning the expected version and account.");
        }
    }
    public async Task<ApplicationPreview> Preview(ApplicationProfile profile, CancellationToken cancellationToken = default)
    {
        var manifest = store.Manifests.Get(profile.ApplicationId);
        ApplicationReadiness readiness;
        var valid = false;
        try
        {
            Validate(profile, manifest);
            valid = true;
            readiness = await Check(profile, manifest, cancellationToken);
        }
        catch (ArgumentException error) { readiness = new(false, error.Message); }
        var identities = manifest.Runtime?.Identities.Select(identity => new IdentityPreview(identity.Name,
            identity.Subject ?? profile.ExpectedUserId, identity.Form is null ? "Development identity" : "Dedicated form session")).ToArray() ??
            [new("primary", profile.ExpectedUserId, "Registered adapter")];
        var fixtures = manifest.Runtime?.Fixtures ?? [];
        var recipeOptions = store.RecipeOptions(profile.ApplicationId);
        CapabilityPreview implementation;
        if (manifest.BuildRecipe is not { } recipe) implementation = new("Codex fixes", "Unsupported", "This manifest enables testing only.");
        else if (!recipeOptions.Recipes.Contains(recipe)) implementation = new("Codex fixes", "Blocked", recipeOptions.Error ?? "Authorize the selected recipe in the local worker configuration.");
        else if (!readiness.Ready || profile.SourceWasDirty || !JobStates.Hash(profile.SourceCommit))
            implementation = new("Codex fixes", "Blocked", "Verify the running target and bind a clean source commit from its launch receipt.");
        else implementation = new("Codex fixes", "Configured", $"Uses {recipe.Id} v{recipe.Version}. Implementation requires explicit approval from a tested run.");
        return new(readiness, valid ? profile.BaseUrl : null, valid ? profile.ExpectedBuildVersion : null, valid ? identities : [],
            manifest.FixtureAdapter, fixtures,
            [new("Testing", readiness.Ready ? "Ready" : "Blocked", readiness.Message),
             new("Fixture provisioning", ApplicationManifests.IsConfiguredTarget(manifest) && fixtures.Length == 0 ? "Unsupported" : readiness.Ready ? "Ready" : "Blocked", fixtures.Length > 0 ?
                "Uses the declared disposable fixture recipes." : ApplicationManifests.IsConfiguredTarget(manifest) ?
                "This manifest has no provisioning recipes." : "Uses the registered adapter's isolated fixture."), implementation],
            valid ? profile.ExpectedCompanyId : null, valid ? profile.ExpectedRole : null);
    }

    public async Task<UatRun> Queue(string testId, CancellationToken cancellationToken = default, bool docked = false, bool stepByStep = false, bool qualification = false)
    {
        var definition = store.QueueDefinitionFor(testId, qualification);
        var test = definition.Test;
        if (test.Readiness == "draft" || !definition.Manifest.Adapters.Any(adapter => adapter.Id == test.Adapter))
            throw new ArgumentException("This workflow's adapter is not implemented yet.");
        if (ApplicationManifests.NeedsTarget(definition.Manifest))
        {
            var profile = definition.Target ?? throw new ArgumentException("Configure the local application instance first.");
            ValidateWorkflowTarget(test, profile);
            var readiness = await Check(profile, definition.Manifest, cancellationToken);
            if (!readiness.Ready) throw new ArgumentException(readiness.Message);
        }
        return store.Queue(definition, qualification, docked, stepByStep);
    }
    public static void ValidateWorkflowTarget(UatTest test, ApplicationProfile? profile)
    {
        if (test.Adapter != WorkflowContract.Adapter) return;
        if (test.Implementation is not { } implementation || test.Readiness != "ready" ||
            implementation.DefinitionDigest != RunStore.DefinitionDigest(test) || implementation.PlanDigest != WorkflowContract.Hash(implementation.PlanJson))
            throw new ArgumentException("This test needs a verified implementation before it can run.");
        if (test.ApplicationId != "getright" && (profile is null || profile.SourceWasDirty || profile.SourceCommit != implementation.ApplicationSourceCommit))
            throw new ArgumentException("This workflow was verified against another application revision. Approve and implement it again against the current clean launch receipt.");
    }

    public Task<CaseImplementationJob> ApproveCase(string id, ApproveCaseRequest request, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var test = store.Test(id);
        ApplicationProfile? profile = null;
        if (test.ApplicationId != "getright")
        {
            profile = store.Profile(test.ApplicationId) ?? throw new ArgumentException("Configure an isolated application launch receipt first.");
        }
        // Approval freezes the clean source receipt, not the lifetime of a
        // manually launched host. The worker builds/starts and verifies its own
        // isolated runtime before either validation can enable the case.
        return Task.FromResult(store.ApproveCase(id, request, profile));
    }

    public Task<CaseImplementationJob> RetryCase(string id, ApproveCaseRequest request, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var previous = store.CaseJob(id);
        var profile = previous.ApplicationId == "getright" ? null
            : store.Profile(previous.ApplicationId) ?? throw new ArgumentException("Configure an isolated application launch receipt first.");
        return Task.FromResult(store.RetryCase(id, request, profile));
    }

    public async Task<string> TestPage(string testId, CancellationToken cancellationToken = default)
    {
        var definition = store.QueueDefinitionFor(testId, false);
        var test = definition.Test;
        if (test.Readiness == "draft") throw new ArgumentException("This test case is a draft. Its entry page has not been verified yet.");
        var manifest = definition.Manifest;
        if (!store.Manifests.Supports(test.ApplicationId, test.Adapter)) throw new ArgumentException("This test case does not have a verified entry page yet.");
        if (!ApplicationManifests.NeedsTarget(manifest) && (test.Adapter == manifest.FixtureAdapter || test.Adapter == ConfiguredWorkflows.Adapter))
            return $"{manifest.EntryPath}?fixture=uat-{Guid.NewGuid():N}";
        var profile = definition.Target ?? throw new ArgumentException("Configure the local application instance first.");
        ValidateWorkflowTarget(test, profile);
        var readiness = await Check(profile, manifest, cancellationToken);
        if (!readiness.Ready) throw new ArgumentException(readiness.Message);
        var entry = test.Workflow?.ReviewPath ?? (test.Implementation is { } implementation ? WorkflowContract.Validate(test, implementation.PlanJson).ReviewPath : manifest.EntryPath);
        return new Uri(new Uri(profile.BaseUrl), entry).AbsoluteUri;
    }
}
