using System.Text.Json;
using System.Text.Json.Serialization;
using System.Collections.Concurrent;
using System.Text.RegularExpressions;

namespace Getright.Dashboard;

public record AdapterVersion(string Id, int Version);
public record BuildRecipeReference(string Id, int Version);
public record BuildRecipeReceipt(BuildRecipeReference Recipe, string RecipeDigest, string ArtifactDigest)
{
    public static bool ValidReference(BuildRecipeReference? reference) => reference is { Id: not null, Version: >= 1 and <= 10000 } &&
        System.Text.RegularExpressions.Regex.IsMatch(reference.Id, @"\A[a-z][a-z0-9-]{0,59}\z");
    public bool ValidFor(BuildRecipeReference? selected) => ValidReference(Recipe) && (selected is null || Recipe == selected) &&
        WorkflowContract.Digest(RecipeDigest) && WorkflowContract.Digest(ArtifactDigest);
}
public record ApplicationManifest(int SchemaVersion, int Revision, string ApplicationId, string FixtureAdapter,
    string EntryPath, AdapterVersion[] Adapters, string[] Capabilities, RuntimePlan? Runtime = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string[]? WorkflowPosts = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] BuildRecipeReference? BuildRecipe = null);
public record RunConfigurationSnapshot(int Version, ApplicationManifest Manifest, string ManifestDigest,
    string WorkflowDigest, string BindingDigest, AdapterVersion Adapter, string? RequiredEngineDigest, string? DashboardBuild);
public record WorkerExecution(int RunConfigurationVersion, string EngineDigest, int? RuntimeContractVersion = null,
    int? ConfiguredWorkflowVersion = null, string? ConfiguredWorkflowDigest = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] int? IntegrationContractVersion = null);
public record ResourceReference(string Kind, string Id, string? ScopeId = null);

// Only registered extensions can interpret a manifest. Their safety and result
// contracts are source-owned; editing a manifest cannot relax them.
public sealed class ApplicationManifests
{
    public const int SnapshotVersion = 1;
    private const int ManifestSchemaVersion = 1;
    private const int AdapterContractVersion = 1;
    public const string ConfiguredTarget = "configured-v2";
    private record Extension(string ApplicationId, string? ResourceKind, bool Scoped);
    private static readonly Dictionary<string, Extension> Extensions = new(StringComparer.Ordinal)
    {
        ["getright-save-note"] = new("getright", null, false),
        ["writerapp-create-save"] = new("writerapp", "document", false),
        ["virtual-company-test-setup"] = new("virtual-company", "company", true)
    };
    private readonly Dictionary<string, ApplicationManifest> manifests;
    private readonly ConcurrentDictionary<string, ApplicationManifest> overrides = new(StringComparer.Ordinal);

    public ApplicationManifests(Catalogue catalogue)
    {
        var options = new JsonSerializerOptions(AppJson.Options) { UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow };
        var definitions = JsonSerializer.Deserialize<ApplicationManifest[]>(
            File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "application-manifests.json")), options)
            ?? throw new InvalidOperationException("Application manifests are missing.");
        foreach (var manifest in definitions) Validate(manifest);
        if (definitions.Select(m => m.ApplicationId).Distinct().Count() != definitions.Length ||
            !definitions.Select(m => m.ApplicationId).ToHashSet().SetEquals(catalogue.Applications.Select(a => a.Id)))
            throw new InvalidOperationException("Each catalogue application needs exactly one application manifest.");
        manifests = definitions.ToDictionary(m => m.ApplicationId, StringComparer.Ordinal);
        if (catalogue.Tests.Any(t => t.Readiness != "draft" && !Supports(t.ApplicationId, t.Adapter)))
            throw new InvalidOperationException("A runnable catalogue test references an unregistered adapter.");
        foreach (var test in catalogue.Tests.Where(t => t.Adapter == ConfiguredWorkflows.Adapter || t.Workflow is not null))
        {
            if (test.Adapter != ConfiguredWorkflows.Adapter || !Supports(test.ApplicationId, test.Adapter))
                throw new InvalidOperationException($"Test '{test.Id}' needs the registered version 2 workflow adapter.");
            ConfiguredWorkflows.Validate(test, Get(test.ApplicationId));
        }
    }

    internal static void Validate(ApplicationManifest? manifest)
    {
        if (manifest is not { SchemaVersion: ManifestSchemaVersion, Revision: > 0, ApplicationId: not null, FixtureAdapter: not null, EntryPath: not null, Adapters: not null, Capabilities: not null } ||
            (IsConfiguredTarget(manifest) ?
                !Regex.IsMatch(manifest.ApplicationId, @"\A[a-z][a-z0-9-]{0,59}\z") ||
                Extensions.Values.Any(extension => extension.ApplicationId == manifest.ApplicationId) ||
                manifest.Adapters.Length != 1 || manifest.Runtime is null :
                !Extensions.TryGetValue(manifest.FixtureAdapter, out var extension) || extension.ApplicationId != manifest.ApplicationId) ||
            !System.Text.RegularExpressions.Regex.IsMatch(manifest.EntryPath, @"\A(?:/[A-Za-z0-9_.-]+)+\z") ||
            manifest.EntryPath.Split('/').Any(s => s is "." or "..") ||
            manifest.Adapters.Any(a => a is null || (a.Id == ConfiguredWorkflows.Adapter ?
                a.Version != ConfiguredWorkflows.Version || (manifest.Runtime is null && NeedsTarget(manifest)) :
                a.Version != AdapterContractVersion || (a.Id != manifest.FixtureAdapter && a.Id != WorkflowContract.Adapter))) ||
            !manifest.Adapters.Any(a => a.Id == manifest.FixtureAdapter) ||
            manifest.Adapters.Select(a => a.Id).Distinct().Count() != manifest.Adapters.Length ||
            !manifest.Capabilities.Contains("test") || manifest.Capabilities.Distinct().Count() != manifest.Capabilities.Length ||
            manifest.Capabilities.Any(c => c != "test" && (c != "implement" || !NeedsTarget(manifest))))
            throw new InvalidOperationException($"Invalid or unsupported application manifest for {manifest?.ApplicationId ?? "unknown application"}.");
        if (manifest.WorkflowPosts is { } posts && (posts.Length > 16 || posts.Any(path => !ConfiguredWorkflows.LocalPath(path) || path.Contains('?')) ||
            posts.Distinct().Count() != posts.Length || !manifest.Adapters.Any(a => a.Id == ConfiguredWorkflows.Adapter)))
            throw new InvalidOperationException("Configured workflow POST paths must be distinct literal paths on the isolated application.");
        if (manifest.Capabilities.Contains("implement") != (manifest.BuildRecipe is not null) ||
            (manifest.BuildRecipe is not null && !BuildRecipeReceipt.ValidReference(manifest.BuildRecipe)))
            throw new InvalidOperationException($"Application '{manifest.ApplicationId}' must declare a valid build recipe when implementation is enabled.");
        if (manifest.Runtime is { } runtime)
        {
            if (!NeedsTarget(manifest)) throw new InvalidOperationException("Configurable runtimes require an isolated application target.");
            RuntimeConfiguration.Validate(runtime, manifest.ApplicationId);
            if (IsConfiguredTarget(manifest)) RuntimeConfiguration.RequireIsolatedTarget(runtime);
        }
        if (!NeedsTarget(manifest) && manifest.WorkflowPosts is { Length: > 0 })
            throw new InvalidOperationException("Dashboard fixtures cannot authorize direct workflow writes.");
    }

    public ApplicationManifest Installed(string applicationId) => manifests.TryGetValue(applicationId, out var manifest)
        ? manifest : throw new ArgumentException("Unknown application manifest.");
    public ApplicationManifest Get(string applicationId) => overrides.TryGetValue(applicationId, out var manifest) ? manifest : Installed(applicationId);
    internal void SetOverride(ApplicationManifest manifest) => overrides[manifest.ApplicationId] = manifest;
    public bool Supports(string applicationId, string? adapter) => Get(applicationId).Adapters.Any(a => a.Id == adapter);
    public static bool IsConfiguredTarget(ApplicationManifest manifest) => manifest.FixtureAdapter == ConfiguredTarget;
    public static bool NeedsTarget(ApplicationManifest manifest) => IsConfiguredTarget(manifest) || Extensions[manifest.FixtureAdapter].ResourceKind is not null;
    public static bool Scoped(ApplicationManifest manifest) => Extensions.TryGetValue(manifest.FixtureAdapter, out var extension) && extension.Scoped;

    internal static string Digest<T>(T value) => WorkflowContract.Hash(JsonSerializer.Serialize(value, AppJson.Options));
    private static string BindingDigest(UatRun run, string? dashboardBuild) =>
        Digest(new { run.Target, run.FixtureId, run.Docked, run.StepByStep, dashboardBuild });

    public RunConfigurationSnapshot Freeze(UatRun run, RunConfigurationSnapshot? original = null)
    {
        var manifest = original?.Manifest ?? Get(run.ApplicationId);
        var adapter = manifest.Adapters.SingleOrDefault(a => a.Id == run.TestSnapshot.Adapter)
            ?? throw new ArgumentException("This workflow's adapter is not registered in its application manifest.");
        var dashboardBuild = NeedsTarget(manifest) ? null : AppJson.BuildVersion;
        if (NeedsTarget(manifest) != (run.Target is not null)) throw new ArgumentException("This workflow needs a matching isolated target binding.");
        var workflowDigest = Digest(run.TestSnapshot);
        if (adapter.Id == ConfiguredWorkflows.Adapter) ConfiguredWorkflows.Validate(run.TestSnapshot, manifest);
        if (original is not null && (original.Version != SnapshotVersion || original.WorkflowDigest != workflowDigest || original.Adapter != adapter))
            throw new ArgumentException("The regression must use the original frozen workflow and adapter version.");
        return new(SnapshotVersion, manifest, original?.ManifestDigest ?? Digest(manifest), workflowDigest,
            BindingDigest(run, dashboardBuild), adapter, run.TestSnapshot.Implementation?.EngineDigest, dashboardBuild);
    }

    public static bool WorkerSupported(WorkerExecution? worker) => worker is { RunConfigurationVersion: SnapshotVersion } && WorkflowContract.Digest(worker.EngineDigest);
    public static bool ConfiguredWorkerSupported(WorkerExecution? worker) =>
        worker is { ConfiguredWorkflowVersion: ConfiguredWorkflows.Version, IntegrationContractVersion: 1 } &&
        WorkflowContract.Digest(worker.ConfiguredWorkflowDigest);
    public static void RequireWorker(RunConfigurationSnapshot snapshot, WorkerExecution? worker)
    {
        if (!WorkerSupported(worker) || (snapshot.RequiredEngineDigest is not null && snapshot.RequiredEngineDigest != worker!.EngineDigest) ||
            (snapshot.Manifest.Runtime is { } runtime && runtime.Version != worker!.RuntimeContractVersion) ||
            (snapshot.Adapter.Id == ConfiguredWorkflows.Adapter && !ConfiguredWorkerSupported(worker)))
            throw new ArgumentException("This run requires a compatible configuration-aware worker and the verified workflow engine.");
    }

    public static ExecutionIdentity? ValidateResult(UatRun run, CompletionRequest request)
    {
        if (run.Configuration?.DashboardBuild is { } build && request.BuildVersion != build)
            throw new ArgumentException("The running dashboard build must match the frozen demo configuration.");
        if (run.Target is not { } target) return request.Identity is { } demo ? demo with { Resources = null } : null;
        var identity = request.Identity;
        if (request.BuildVersion != target.ExpectedBuildVersion || request.BaseUrl != target.BaseUrl ||
            identity is null || identity.UserId != target.ExpectedUserId || identity.EvidenceKind != "live-application")
            throw new ArgumentException("The tested application, build, account and resource must match the run's frozen target.");
        if (run.Configuration?.Adapter.Id == ConfiguredWorkflows.Adapter) return ConfiguredWorkflows.ValidateResources(run, identity);
        var extension = run.Configuration is { } configuration ? Extensions[configuration.Manifest.FixtureAdapter] :
            Extensions.Values.Single(e => e.ApplicationId == run.ApplicationId);

        // Project the existing adapter payload into the typed resource contract.
        // Scope and role still come from the verified fixture, never catalogue text.
        var resourceId = extension.Scoped ? identity.CompanyId : identity.DocumentId;
        var scopeId = extension.Scoped ? identity.IsolationCompanyId : null;
        if (!Guid.TryParse(resourceId, out var resource) || (extension.Scoped &&
            (scopeId != target.ExpectedCompanyId || !Guid.TryParse(target.ExpectedCompanyId, out var scope) || resource == scope || identity.Roles?.Contains(target.ExpectedRole!) != true)))
            throw new ArgumentException("The tested application, build, account and resource must match the run's frozen target.");
        return identity with { Resources = run.Configuration is null ? null : [new(extension.ResourceKind!, resourceId!, scopeId)] };
    }
}
