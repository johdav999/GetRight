using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace Getright.Dashboard;

public record DefinitionEdit(int Revision, string DefinitionJson, string? Id = null);
public record LocalWorkflow(int Revision, UatTest Test);
public record QualificationAttempt(string RunId, string Status, string Acceptance);
public record WorkflowQualification(int Revision, bool Qualified, string Message, QualificationAttempt[] Attempts);
public record RecipeChoices(BuildRecipeReference[] Recipes, string? Error = null);
internal record QueueDefinition(UatTest Test, ApplicationManifest Manifest, ApplicationProfile? Target, int? Revision, string? QualificationKey);

internal static class LocalDefinitions
{
    private static readonly JsonSerializerOptions StrictJson = new(AppJson.Options) { UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow };

    public static T Parse<T>(string? json) where T : class
    {
        RunStore.RequireText(json, "Definition JSON", 65536);
        try { return JsonSerializer.Deserialize<T>(json!, StrictJson) ?? throw new ArgumentException("Provide a JSON definition."); }
        catch (JsonException) { throw new ArgumentException("Invalid definition JSON or unsupported schema fields."); }
    }

    public static void ValidateManifest(ApplicationManifest installed, ApplicationManifest candidate)
    {
        try { ApplicationManifests.Validate(candidate); }
        catch (InvalidOperationException error) { throw new ArgumentException(error.Message); }
        if (candidate.ApplicationId != installed.ApplicationId || candidate.FixtureAdapter != installed.FixtureAdapter ||
            !candidate.Adapters.SequenceEqual(installed.Adapters) ||
            (candidate.WorkflowPosts ?? []).Except(installed.WorkflowPosts ?? []).Any())
            throw new ArgumentException("Use the installed fixture, adapter versions and authorized POST paths. Worker policy is configured locally.");
        if (installed.Runtime is not { } baseline)
        {
            if (candidate.Runtime is not null) throw new ArgumentException("Authorize a runtime plan in the installed manifest before editing it here.");
            return;
        }
        var identities = candidate.Runtime?.Identities ?? [];
        if (identities.Length == 0 || identities[0].Name != baseline.Identities[0].Name)
            throw new ArgumentException("Retain the installed runtime and its primary build and identity checks.");
        foreach (var identity in identities)
        {
            var original = baseline.Identities.SingleOrDefault(item => item.Name == identity.Name);
            if (identity.Form != original?.Form)
                throw new ArgumentException("Form sign-in and credential references must be authorized in the installed manifest.");
        }
        foreach (var original in baseline.Identities)
        {
            var identity = identities.SingleOrDefault(item => item.Name == original.Name);
            if (identity is null || identity.Subject != original.Subject || original.Checks.Select(ApplicationManifests.Digest)
                .Except(identity.Checks.Select(ApplicationManifests.Digest)).Any())
                throw new ArgumentException("Retain the installed identity bindings and runtime checks.");
        }
    }

    public static RecipeChoices Recipes(string applicationId)
    {
        var root = new DirectoryInfo(AppContext.BaseDirectory);
        while (root.Parent is not null && !File.Exists(Path.Combine(root.FullName, "Getright.sln"))) root = root.Parent;
        var defaultRoot = File.Exists(Path.Combine(root.FullName, "Getright.sln")) ? root.FullName : AppContext.BaseDirectory;
        var localPath = Environment.GetEnvironmentVariable("GETRIGHT_WORKER_CONFIG") ?? Path.Combine(defaultRoot, "config", "worker.local.json");
        var choices = new Dictionary<string, BuildRecipeReference>(StringComparer.Ordinal);
        try
        {
            using var bundled = Read(Path.Combine(AppContext.BaseDirectory, "build-recipes.json"));
            Load(bundled.RootElement);
            if (File.Exists(localPath))
            {
                using var local = Read(localPath);
                if (local.RootElement.TryGetProperty("recipes", out var recipes)) Load(recipes);
            }
            return new(choices.Values.OrderBy(item => item.Id).ToArray());
        }
        catch (Exception error) when (error is IOException or JsonException or InvalidOperationException or UnauthorizedAccessException or ArgumentException)
        {
            return new([], "The local worker recipe configuration could not be read. Check the worker configuration file.");
        }

        static JsonDocument Read(string path)
        {
            var info = new FileInfo(path);
            if (info.Length > 256 * 1024) throw new InvalidOperationException();
            return JsonDocument.Parse(File.ReadAllText(path));
        }
        void Load(JsonElement recipes)
        {
            foreach (var item in recipes.EnumerateObject())
            {
                choices.Remove(item.Name);
                if (item.Value.ValueKind != JsonValueKind.Object || !item.Value.TryGetProperty("applicationId", out var app) ||
                    app.ValueKind != JsonValueKind.String || app.GetString() != applicationId ||
                    !item.Value.TryGetProperty("version", out var version) || version.ValueKind != JsonValueKind.Number || !version.TryGetInt32(out var number)) continue;
                var reference = new BuildRecipeReference(item.Name, number);
                if (BuildRecipeReceipt.ValidReference(reference)) choices.Add(reference.Id, reference);
            }
        }
    }
}

public sealed partial class RunStore
{
    private readonly Dictionary<string, string> manifestWarnings = new(StringComparer.Ordinal);

    public string? ManifestWarning(string applicationId)
    {
        lock (gate) return manifestWarnings.GetValueOrDefault(applicationId);
    }

    private void LoadManifestOverrides()
    {
        using var db = Open(); using var command = db.CreateCommand();
        command.CommandText = "SELECT id,payload FROM local_manifests";
        using var reader = command.ExecuteReader();
        while (reader.Read())
        {
            var id = reader.GetString(0);
            try
            {
                var manifest = LocalDefinitions.Parse<ApplicationManifest>(reader.GetString(1));
                LocalDefinitions.ValidateManifest(Manifests.Installed(id), manifest);
                Manifests.SetOverride(manifest);
            }
            catch (ArgumentException)
            {
                manifestWarnings[id] = "The saved manifest conflicts with the installed application policy. Review and save a compatible definition.";
            }
        }
    }

    public RecipeChoices RecipeOptions(string applicationId)
    {
        _ = Manifests.Installed(applicationId);
        return LocalDefinitions.Recipes(applicationId);
    }

    public ApplicationManifest SaveManifest(string applicationId, DefinitionEdit request)
    {
        lock (gate)
        {
            var previous = Manifests.Get(applicationId);
            if (request.Revision != previous.Revision) throw new ArgumentException("The manifest changed. Reload it before saving.");
            var candidate = LocalDefinitions.Parse<ApplicationManifest>(request.DefinitionJson) with { Revision = checked(previous.Revision + 1) };
            LocalDefinitions.ValidateManifest(Manifests.Installed(applicationId), candidate);
            if (candidate.BuildRecipe is { } recipe && !RecipeOptions(applicationId).Recipes.Contains(recipe))
                throw new ArgumentException("Choose a recipe authorized in the local worker configuration.");
            foreach (var test in catalogue.Value.Tests.Concat(ManagedWorkflows(applicationId).Select(item => item.Test))
                .Where(test => test.ApplicationId == applicationId && test.Adapter == ConfiguredWorkflows.Adapter))
                ConfiguredWorkflows.Validate(test, candidate);
            using var db = Open(); using var command = db.CreateCommand();
            command.CommandText = "INSERT INTO local_manifests(id,payload) VALUES($id,$payload) ON CONFLICT(id) DO UPDATE SET payload=$payload";
            command.Parameters.AddWithValue("$id", applicationId);
            command.Parameters.AddWithValue("$payload", JsonSerializer.Serialize(candidate, AppJson.Options));
            command.ExecuteNonQuery();
            Manifests.SetOverride(candidate);
            manifestWarnings.Remove(applicationId);
            return candidate;
        }
    }

    public List<LocalWorkflow> ManagedWorkflows(string? applicationId = null)
    {
        lock (gate)
        {
            using var db = Open(); using var command = db.CreateCommand();
            command.CommandText = "SELECT payload FROM local_workflows WHERE $app IS NULL OR application_id=$app ORDER BY rowid";
            command.Parameters.AddWithValue("$app", (object?)applicationId ?? DBNull.Value);
            using var reader = command.ExecuteReader();
            var result = new List<LocalWorkflow>();
            while (reader.Read()) result.Add(JsonSerializer.Deserialize<LocalWorkflow>(reader.GetString(0), AppJson.Options)!);
            return result;
        }
    }

    private LocalWorkflow? ManagedWorkflow(string id)
    {
        using var db = Open(); using var command = db.CreateCommand();
        command.CommandText = "SELECT payload FROM local_workflows WHERE id=$id";
        command.Parameters.AddWithValue("$id", id);
        return command.ExecuteScalar() is string json ? JsonSerializer.Deserialize<LocalWorkflow>(json, AppJson.Options) : null;
    }

    public LocalWorkflow SaveWorkflow(string applicationId, DefinitionEdit request)
    {
        lock (gate)
        {
            var manifest = Manifests.Get(applicationId);
            var test = LocalDefinitions.Parse<UatTest>(request.DefinitionJson);
            if (!ApplicationManifests.NeedsTarget(manifest) || test.ApplicationId != applicationId || test.Adapter != ConfiguredWorkflows.Adapter ||
                !Manifests.Supports(applicationId, test.Adapter) || test.Id is null || !Regex.IsMatch(test.Id, @"\A[a-z0-9][a-z0-9-]{0,79}\z") ||
                test.Implementation is not null || test.GenerationId is not null || test.Steps is null || test.Steps.Any(step => step is null) ||
                test.Steps.Select(step => step.Id).Distinct().Count() != test.Steps.Count)
                throw new ArgumentException("Import a version 2 workflow for this registered application with a unique test ID and step IDs.");
            RequireText(test.Title, "Test title", 180); RequireText(test.Purpose, "Purpose", 2000); RequireText(test.ReviewQuestion, "Review question", 1000);
            if (test.Preconditions?.Length > 3000) throw new ArgumentException("Preconditions must be at most 3000 characters.");
            foreach (var step in test.Steps) { RequireText(step.Title, "Step title", 1000); RequireText(step.Expected, "Step expectation", 1500); }
            test = test with { Readiness = "setup-required" };
            ConfiguredWorkflows.Validate(test, manifest);

            var previous = ManagedWorkflow(test.Id);
            if (previous is null && (request.Revision != 0 || request.Id is not null || Tests().Any(item => item.Id == test.Id)))
                throw new ArgumentException("Use a new test ID. Imported workflows cannot replace installed or generated tests.");
            if (previous is not null && (request.Id != test.Id || request.Revision != previous.Revision || previous.Test.ApplicationId != applicationId ||
                !previous.Test.Steps.Select(step => step.Id).SequenceEqual(test.Steps.Select(step => step.Id))))
                throw new ArgumentException("Reload the workflow before saving. Keep its test ID and ordered step IDs, or import a new test.");
            var updated = new LocalWorkflow((previous?.Revision ?? 0) + 1, test);
            var suite = previous is null ? Suite($"{applicationId}-suite") : null;
            if (suite?.TestIds.Count >= 250) throw new ArgumentException("The default application suite is full. Remove a case before importing another.");
            using var db = Open(); using var transaction = db.BeginTransaction(); using var command = db.CreateCommand();
            command.Transaction = transaction;
            command.CommandText = "INSERT INTO local_workflows(id,application_id,payload) VALUES($id,$app,$payload) ON CONFLICT(id) DO UPDATE SET payload=$payload";
            command.Parameters.AddWithValue("$id", test.Id); command.Parameters.AddWithValue("$app", applicationId);
            command.Parameters.AddWithValue("$payload", JsonSerializer.Serialize(updated, AppJson.Options));
            command.ExecuteNonQuery();
            if (suite is not null) WriteSuite(db, transaction, suite with { TestIds = [.. suite.TestIds, test.Id], Revision = suite.Revision + 1 });
            transaction.Commit();
            return updated;
        }
    }

    private static string QualificationKey(LocalWorkflow workflow, ApplicationManifest manifest, ApplicationProfile target) =>
        ApplicationManifests.Digest(new { workflow, manifest, target });

    private QualificationAttempt[] QualificationAttempts(string key)
    {
        using var db = Open(); using var command = db.CreateCommand();
        command.CommandText = """
            SELECT id,json_extract(payload,'$.status'),json_extract(payload,'$.acceptance') FROM runs
            WHERE json_extract(payload,'$.qualificationKey')=$key ORDER BY rowid DESC LIMIT 2
            """;
        command.Parameters.AddWithValue("$key", key);
        using var reader = command.ExecuteReader();
        var result = new List<QualificationAttempt>();
        while (reader.Read()) result.Add(new(reader.GetString(0), reader.GetString(1), reader.GetString(2)));
        return result.ToArray();
    }

    public WorkflowQualification Qualification(string testId)
    {
        lock (gate)
        {
            ExpireRuns();
            var workflow = ManagedWorkflow(testId) ?? throw new ArgumentException("Only imported workflows use this qualification process.");
            var target = Profile(workflow.Test.ApplicationId);
            var manifest = Manifests.Get(workflow.Test.ApplicationId);
            return Qualification(workflow, manifest, target);
        }
    }

    private WorkflowQualification Qualification(LocalWorkflow workflow, ApplicationManifest manifest, ApplicationProfile? target)
    {
        if (manifestWarnings.TryGetValue(workflow.Test.ApplicationId, out var warning)) return new(workflow.Revision, false, warning, []);
        try { ConfiguredWorkflows.Validate(workflow.Test, manifest); }
        catch (ArgumentException error) { return new(workflow.Revision, false, error.Message, []); }
        if (target is null) return new(workflow.Revision, false, "Save an isolated target binding before qualifying this workflow.", []);
        var attempts = QualificationAttempts(QualificationKey(workflow, manifest, target));
        if (attempts.Length == 2 && attempts.All(attempt => attempt.Status == "passed"))
            return new(workflow.Revision, true, "Qualified on this definition and target.", attempts);
        var message = attempts.Any(attempt => attempt.Status is "queued" or "running") ? "Qualification is in progress." :
            "Two consecutive passing qualification runs are required for this definition and target.";
        return new(workflow.Revision, false, message, attempts);
    }

    internal QueueDefinition QueueDefinitionFor(string id, bool qualification)
    {
        lock (gate)
        {
            ExpireRuns();
            var managed = ManagedWorkflow(id);
            var test = managed?.Test ?? Test(id);
            var manifest = Manifests.Get(test.ApplicationId);
            var target = ApplicationManifests.NeedsTarget(manifest) ? Profile(test.ApplicationId) : null;
            if (qualification && managed is null) throw new ArgumentException("Only imported workflows use qualification runs.");
            if (managed is not null)
            {
                if (manifestWarnings.TryGetValue(test.ApplicationId, out var warning)) throw new ArgumentException(warning);
                ConfiguredWorkflows.Validate(test, manifest);
                var state = Qualification(managed, manifest, target);
                if (!qualification && !state.Qualified) throw new ArgumentException(state.Message);
                if (qualification && (state.Qualified || state.Attempts.Any(attempt => attempt.Status is "queued" or "running")))
                    throw new ArgumentException(state.Message);
            }
            return new(test, manifest, target, managed?.Revision, qualification && target is not null ? QualificationKey(managed!, manifest, target) : null);
        }
    }
}
