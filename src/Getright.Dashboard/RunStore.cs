using System.Text;
using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace Getright.Dashboard;

// One dashboard process owns the local database. Each mutation is serialized and
// writes a complete snapshot, retaining the test definition used for that run.
public sealed class RunStore
{
    private readonly object gate = new();
    private readonly string connectionString;
    private readonly UatCatalogue catalogue;
    public string DataPath { get; }
    public static string ResolveDataPath(IConfiguration configuration)
    {
        var root = new DirectoryInfo(AppContext.BaseDirectory);
        while (root.Parent is not null && !File.Exists(Path.Combine(root.FullName, "Getright.sln"))) root = root.Parent;
        var defaultRoot = File.Exists(Path.Combine(root.FullName, "Getright.sln")) ? root.FullName : AppContext.BaseDirectory;
        return Path.GetFullPath(configuration["Getright:DataPath"] ?? Path.Combine(defaultRoot, "data"));
    }
    public RunStore(IConfiguration configuration, UatCatalogue catalogue)
    {
        this.catalogue = catalogue;
        DataPath = ResolveDataPath(configuration);
        Directory.CreateDirectory(Path.Combine(DataPath, "evidence"));
        connectionString = new SqliteConnectionStringBuilder
        {
            DataSource = Path.Combine(DataPath, "getright.db"), ForeignKeys = true
        }.ToString();
        using var db = Open();
        using var command = db.CreateCommand();
        command.CommandText = "PRAGMA journal_mode=WAL;";
        command.ExecuteNonQuery();
        command.CommandText = "PRAGMA user_version";
        var schemaVersion = Convert.ToInt32(command.ExecuteScalar());
        if (schemaVersion > 2) throw new InvalidOperationException("This database requires a newer Getright version.");
        using (var transaction = db.BeginTransaction())
        {
            command.Transaction = transaction;
            if (schemaVersion == 0)
            {
                command.CommandText = """
                    CREATE TABLE runs (id TEXT PRIMARY KEY, payload TEXT NOT NULL, lease TEXT);
                    CREATE TABLE feedback (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), payload TEXT NOT NULL);
                    PRAGMA user_version=1;
                    """;
                command.ExecuteNonQuery();
            }
            if (schemaVersion < 2)
            {
                command.CommandText = "CREATE TABLE application_profiles (id TEXT PRIMARY KEY, payload TEXT NOT NULL); PRAGMA user_version=2;";
                command.ExecuteNonQuery();
            }
            transaction.Commit();
        }
        // A restarted dashboard cannot vouch for workers from the old process.
        foreach (var run in List().Where(r => r.Status == "running"))
            Save(run with { Status = "interrupted", CompletedAt = DateTimeOffset.UtcNow,
                Error = "Dashboard restarted during execution. Queue a new run." });
    }

    private SqliteConnection Open() { var db = new SqliteConnection(connectionString); db.Open(); return db; }
    public List<UatRun> List()
    {
        lock (gate)
        {
            using var db = Open(); using var cmd = db.CreateCommand();
            cmd.CommandText = "SELECT payload FROM runs ORDER BY rowid DESC";
            using var reader = cmd.ExecuteReader(); var result = new List<UatRun>();
            while (reader.Read()) result.Add(JsonSerializer.Deserialize<UatRun>(reader.GetString(0), AppJson.Options)!);
            return result;
        }
    }
    public UatRun Get(string id) => List().FirstOrDefault(r => r.Id == id)
        ?? throw new ArgumentException("Unknown run.");
    private void Save(UatRun run, string? lease = null)
    {
        using var db = Open(); using var cmd = db.CreateCommand();
        cmd.CommandText = "INSERT INTO runs(id,payload,lease) VALUES($id,$payload,$lease) ON CONFLICT(id) DO UPDATE SET payload=$payload,lease=$lease";
        cmd.Parameters.AddWithValue("$id", run.Id);
        cmd.Parameters.AddWithValue("$payload", JsonSerializer.Serialize(run, AppJson.Options));
        cmd.Parameters.AddWithValue("$lease", (object?)lease ?? DBNull.Value); cmd.ExecuteNonQuery();
    }
    public UatRun Queue(string testId, ApplicationProfile? target = null)
    {
        lock (gate)
        {
            var test = catalogue.Get(testId);
            var demo = test.ApplicationId == "getright" && test.Adapter == "getright-save-note" && test.Readiness == "ready";
            var writer = test.ApplicationId == "writerapp" && test.Adapter == "writerapp-create-save" && target?.ApplicationId == "writerapp";
            if (!demo && !writer)
                throw new ArgumentException("This test needs an application adapter before it can run.");
            if (writer) ApplicationSetup.Validate(target!);
            var id = Guid.NewGuid().ToString("N");
            var run = new UatRun(id, test.Id, test.ApplicationId, "queued", "pending",
                DateTimeOffset.UtcNow, null, null, $"uat-{id}", null, null, [], null, null, test, writer ? target : null);
            Save(run); return run;
        }
    }
    public RunLease? Claim()
    {
        lock (gate)
        {
            foreach (var stale in List().Where(r => r.Status == "running" &&
                r.StartedAt < DateTimeOffset.UtcNow.AddMinutes(-10)))
                Save(stale with { Status = "interrupted", CompletedAt = DateTimeOffset.UtcNow,
                    Error = "Worker lease expired. Queue a new run." });
            var run = List().LastOrDefault(r => r.Status == "queued");
            if (run is null) return null;
            run = run with { Status = "running", StartedAt = DateTimeOffset.UtcNow };
            var lease = Guid.NewGuid().ToString("N"); Save(run, lease);
            return new RunLease(run, lease);
        }
    }
    private string? Lease(string id)
    {
        using var db = Open(); using var cmd = db.CreateCommand();
        cmd.CommandText = "SELECT lease FROM runs WHERE id=$id"; cmd.Parameters.AddWithValue("$id", id);
        return cmd.ExecuteScalar() as string;
    }
    public UatRun Complete(string id, CompletionRequest request)
    {
        lock (gate)
        {
            var run = Get(id);
            if (run.Status != "running" || string.IsNullOrWhiteSpace(request.Lease) || Lease(id) != request.Lease)
                throw new ArgumentException("The worker lease is no longer valid.");
            if (request.Status is not ("passed" or "failed")) throw new ArgumentException("Invalid result status.");
            var steps = request.Steps ?? [];
            if (steps.Select(s => s.StepId).Distinct().Count() != steps.Count ||
                steps.Any(s => !run.TestSnapshot.Steps.Any(t => t.Id == s.StepId) || s.Status is not ("passed" or "failed")))
                throw new ArgumentException("Invalid step results.");
            foreach (var step in steps) ValidateEvidence(run.Id, step.Screenshot);
            ValidateEvidence(run.Id, request.Trace);
            if (request.Status == "passed" && (steps.Count != run.TestSnapshot.Steps.Count ||
                steps.Any(s => s.Status != "passed" || s.Screenshot is null) || request.Trace is null ||
                string.IsNullOrWhiteSpace(request.BuildVersion) || string.IsNullOrWhiteSpace(request.BaseUrl)))
                throw new ArgumentException("Passing runs require every step, screenshots, trace and tested build identity.");
            if (request.Status == "passed" && run.Target is { } target &&
                (request.BuildVersion != target.ExpectedBuildVersion || request.BaseUrl != target.BaseUrl ||
                 request.Identity?.UserId != target.ExpectedUserId || request.Identity.EvidenceKind != "live-application" ||
                 !Guid.TryParse(request.Identity.DocumentId, out _)))
                throw new ArgumentException("The tested application, build, account and document must match the run's frozen target.");
            run = run with { Status = request.Status, CompletedAt = DateTimeOffset.UtcNow,
                BuildVersion = request.BuildVersion, BaseUrl = request.BaseUrl, Steps = steps,
                Trace = request.Trace, Error = request.Error, Identity = request.Identity };
            Save(run); return run;
        }
    }
    private void ValidateEvidence(string id, string? path)
    {
        if (path is null) return;
        var parts = path.Split('/');
        if (parts.Length != 2 || parts[0] != id || Path.GetFileName(parts[1]) != parts[1] ||
            parts[1].Contains('\\') || !File.Exists(Path.Combine(DataPath, "evidence", id, parts[1])))
            throw new ArgumentException("Evidence must exist inside this run's evidence folder.");
    }
    public string? EvidencePath(string id, string file)
    {
        if (file.Contains('/') || file.Contains('\\') || Path.GetFileName(file) != file) return null;
        var run = Get(id); var reference = $"{id}/{file}";
        return run.Trace == reference || run.Steps.Any(s => s.Screenshot == reference)
            ? Path.Combine(DataPath, "evidence", id, file) : null;
    }
    public UatRun Review(string id, string acceptance)
    {
        lock (gate)
        {
            var run = Get(id);
            if (run.Status is "queued" or "running") throw new ArgumentException("Review a completed run.");
            if (acceptance is not ("accepted" or "improvements-requested" or "pending"))
                throw new ArgumentException("Invalid review status.");
            Save(run with { Acceptance = acceptance }); return Get(id);
        }
    }
    public List<Feedback> FeedbackFor(string id)
    {
        lock (gate)
        {
            using var db = Open(); using var cmd = db.CreateCommand();
            cmd.CommandText = "SELECT payload FROM feedback WHERE run_id=$id ORDER BY rowid";
            cmd.Parameters.AddWithValue("$id", id); using var reader = cmd.ExecuteReader();
            var result = new List<Feedback>();
            while (reader.Read()) result.Add(JsonSerializer.Deserialize<Feedback>(reader.GetString(0), AppJson.Options)!);
            return result;
        }
    }
    public Feedback AddFeedback(string id, FeedbackRequest request)
    {
        lock (gate)
        {
            var run = Get(id);
            if (run.Status is "queued" or "running") throw new ArgumentException("Review a completed run.");
            var step = run.TestSnapshot.Steps.FirstOrDefault(s => s.Id == request.StepId)
                ?? throw new ArgumentException("Unknown test step.");
            if (string.IsNullOrWhiteSpace(request.Comment) || string.IsNullOrWhiteSpace(request.RequestedOutcome) ||
                request.Comment.Length > 8000 || request.RequestedOutcome.Length > 8000)
                throw new ArgumentException("Provide feedback and a requested outcome (up to 8000 characters each).");
            var screenshot = run.Steps.FirstOrDefault(s => s.StepId == step.Id)?.Screenshot;
            var prompt = new StringBuilder()
                .AppendLine($"Application: {run.ApplicationId}\nTest: {run.TestSnapshot.Title} ({run.TestId})")
                .AppendLine($"Run: {run.Id}\nTested build: {run.BuildVersion ?? "unavailable"}\nEnvironment: {run.BaseUrl ?? "unavailable"}")
                .AppendLine($"Fixture: {run.FixtureId}\nStep: {step.Title} ({step.Id})\nExpected: {step.Expected}")
                .AppendLine($"Evidence scope: {run.Identity?.EvidenceKind ?? (run.ApplicationId == "getright" ? "demo" : "unverified")}\nTest account: {run.Identity?.UserId ?? "unavailable"}\nDocument: {run.Identity?.DocumentId ?? "unavailable"}")
                .AppendLine($"Source revision from build receipt: {run.Target?.SourceCommit ?? "not supplied"}\nSource had local changes: {(run.Target?.SourceCommit is null ? "not recorded" : run.Target.SourceWasDirty.ToString())}")
                .AppendLine($"Account roles: {string.Join(", ", run.Identity?.Roles ?? [])}")
                .AppendLine($"Automated result: {run.Status}\nScreenshot: {screenshot ?? "unavailable"}\nTrace: {run.Trace ?? "unavailable"}")
                .AppendLine($"\nUser feedback:\n{request.Comment.Trim()}\n\nRequested outcome:\n{request.RequestedOutcome.Trim()}")
                .AppendLine("\nAcceptance:\n- Address the requested outcome while preserving the existing workflow.")
                .AppendLine("- Rerun the original test using isolated data and record the actual running build and evidence.")
                .AppendLine("- Leave human acceptance pending for the new run.")
                .AppendLine("\nExecution: use a dedicated Git worktree. Record base and resulting commits. Do not merge, deploy or publish.")
                .ToString();
            var feedback = new Feedback(Guid.NewGuid().ToString("N"), id, step.Id,
                request.Comment.Trim(), request.RequestedOutcome.Trim(), DateTimeOffset.UtcNow, prompt);
            using var db = Open(); using var transaction = db.BeginTransaction();
            using var cmd = db.CreateCommand(); cmd.Transaction = transaction;
            cmd.CommandText = "INSERT INTO feedback(id,run_id,payload) VALUES($id,$run,$payload); UPDATE runs SET payload=$runPayload WHERE id=$run";
            cmd.Parameters.AddWithValue("$id", feedback.Id); cmd.Parameters.AddWithValue("$run", id);
            cmd.Parameters.AddWithValue("$payload", JsonSerializer.Serialize(feedback, AppJson.Options));
            cmd.Parameters.AddWithValue("$runPayload", JsonSerializer.Serialize(run with { Acceptance = "improvements-requested" }, AppJson.Options));
            cmd.ExecuteNonQuery(); transaction.Commit(); return feedback;
        }
    }

    public ApplicationProfile? Profile(string applicationId)
    {
        lock (gate)
        {
            using var db = Open(); using var cmd = db.CreateCommand();
            cmd.CommandText = "SELECT payload FROM application_profiles WHERE id=$id";
            cmd.Parameters.AddWithValue("$id", applicationId);
            return cmd.ExecuteScalar() is string payload ? JsonSerializer.Deserialize<ApplicationProfile>(payload, AppJson.Options) : null;
        }
    }
    public ApplicationProfile SaveProfile(ApplicationProfile profile)
    {
        lock (gate)
        {
            ApplicationSetup.Validate(profile);
            profile = profile with { BaseUrl = new Uri(profile.BaseUrl).GetLeftPart(UriPartial.Authority),
                ExpectedBuildVersion = profile.ExpectedBuildVersion.Trim(), ExpectedUserId = profile.ExpectedUserId.Trim() };
            using var db = Open(); using var cmd = db.CreateCommand();
            cmd.CommandText = "INSERT INTO application_profiles(id,payload) VALUES($id,$payload) ON CONFLICT(id) DO UPDATE SET payload=$payload";
            cmd.Parameters.AddWithValue("$id", profile.ApplicationId);
            cmd.Parameters.AddWithValue("$payload", JsonSerializer.Serialize(profile, AppJson.Options));
            cmd.ExecuteNonQuery(); return profile;
        }
    }
}
