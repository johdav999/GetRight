using System.Text;
using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace Getright.Dashboard;

// One dashboard process owns the local database. Each mutation is serialized and
// writes a complete snapshot, retaining the test definition used for that run.
public sealed partial class RunStore
{
    private readonly object gate = new();
    private readonly string connectionString;
    private readonly UatCatalogue catalogue;
    public ApplicationManifests Manifests => catalogue.Manifests;
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
        if (schemaVersion > 8) throw new InvalidOperationException("This database requires a newer Getright version.");
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
            if (schemaVersion < 3)
            {
                command.CommandText = """
                    CREATE TABLE improvement_jobs (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), feedback_id TEXT NOT NULL REFERENCES feedback(id), payload TEXT NOT NULL, lease TEXT, lease_expires TEXT);
                    CREATE TABLE job_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL REFERENCES improvement_jobs(id), created_at TEXT NOT NULL, stage TEXT NOT NULL, message TEXT NOT NULL);
                    CREATE INDEX job_events_job ON job_events(job_id, sequence);
                    PRAGMA user_version=3;
                    """;
                command.ExecuteNonQuery();
            }
            if (schemaVersion < 4)
            {
                command.CommandText = """
                    ALTER TABLE runs ADD COLUMN lease_expires TEXT;
                    CREATE TABLE review_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(id), created_at TEXT NOT NULL, action TEXT NOT NULL, previous TEXT NOT NULL, current TEXT NOT NULL, feedback_id TEXT);
                    CREATE INDEX review_events_run ON review_events(run_id, sequence);
                    CREATE INDEX runs_status ON runs(json_extract(payload,'$.status'));
                    CREATE INDEX runs_test ON runs(json_extract(payload,'$.testId'));
                    CREATE INDEX jobs_status ON improvement_jobs(json_extract(payload,'$.status'));
                    CREATE TABLE cleanup_tasks(id TEXT PRIMARY KEY, payload TEXT NOT NULL, lease TEXT, lease_expires TEXT);
                    PRAGMA user_version=4;
                    """;
                command.ExecuteNonQuery();
            }
            if (schemaVersion < 5)
            {
                command.CommandText = """
                    CREATE TABLE test_suites(id TEXT PRIMARY KEY, payload TEXT NOT NULL);
                    CREATE TABLE draft_test_cases(id TEXT PRIMARY KEY, suite_id TEXT NOT NULL REFERENCES test_suites(id), payload TEXT NOT NULL);
                    CREATE TABLE case_proposals(id TEXT PRIMARY KEY, suite_id TEXT NOT NULL REFERENCES test_suites(id), payload TEXT NOT NULL);
                    CREATE INDEX case_proposals_suite ON case_proposals(suite_id);
                    PRAGMA user_version=5;
                    """;
                command.ExecuteNonQuery();
            }
            if (schemaVersion < 6)
            {
                command.CommandText = """
                    CREATE TABLE case_implementation_jobs(id TEXT PRIMARY KEY,test_id TEXT NOT NULL,payload TEXT NOT NULL,lease TEXT,lease_expires TEXT);
                    CREATE TABLE case_implementation_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,job_id TEXT NOT NULL REFERENCES case_implementation_jobs(id),created_at TEXT NOT NULL,stage TEXT NOT NULL,message TEXT NOT NULL);
                    CREATE INDEX case_implementation_test ON case_implementation_jobs(test_id);
                    CREATE INDEX case_implementation_status ON case_implementation_jobs(json_extract(payload,'$.status'));
                    CREATE TABLE case_bindings(test_id TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES case_implementation_jobs(id),payload TEXT NOT NULL);
                    PRAGMA user_version=6;
                    """;
                command.ExecuteNonQuery();
            }
            // Snapshot and resource fields are additive JSON. Do not invent a
            // manifest or engine identity for any pre-upgrade run or profile.
            if (schemaVersion < 7)
            {
                command.CommandText = "PRAGMA user_version=7;";
                command.ExecuteNonQuery();
            }
            if (schemaVersion < 8)
            {
                command.CommandText = """
                    CREATE TABLE local_manifests (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
                    CREATE TABLE local_workflows (id TEXT PRIMARY KEY, application_id TEXT NOT NULL, payload TEXT NOT NULL);
                    CREATE INDEX runs_qualification ON runs(json_extract(payload,'$.qualificationKey'))
                      WHERE json_extract(payload,'$.qualificationKey') IS NOT NULL;
                    PRAGMA user_version=8;
                    """;
                command.ExecuteNonQuery();
            }
            SeedSuites(db, transaction);
            transaction.Commit();
        }
        LoadManifestOverrides();
        // A restarted dashboard cannot vouch for workers from the old process.
        foreach (var run in ReadRuns("WHERE json_extract(payload,'$.status') = 'running'"))
            Save(run with { Status = "interrupted", CompletedAt = DateTimeOffset.UtcNow,
                Error = "Dashboard restarted during execution. Queue a new run." });
        RecoverCleanups();
        foreach (var job in ReadJobs("WHERE json_extract(payload,'$.status') IN ('preparing','implementing','building','launching','rerunning')"))
            EndJob(job, "interrupted", "Dashboard restarted. The worktree is retained; create a new job to retry.");
        RecoverCaseJobs();
    }

    private SqliteConnection Open() { var db = new SqliteConnection(connectionString); db.Open(); return db; }
    private List<UatRun> ReadRuns(string suffix)
    {
        using var db = Open(); using var cmd = db.CreateCommand();
        cmd.CommandText = "SELECT payload FROM runs " + suffix;
        using var reader = cmd.ExecuteReader(); var result = new List<UatRun>();
        while (reader.Read()) result.Add(JsonSerializer.Deserialize<UatRun>(reader.GetString(0), AppJson.Options)!);
        return result;
    }
    public List<UatRun> List() { lock (gate) { Sweep(); return ReadRuns("ORDER BY rowid DESC LIMIT 100"); } }
    public UatRun Get(string id)
    {
        lock (gate)
        {
            ExpireRuns(); using var db = Open(); using var cmd = db.CreateCommand();
            cmd.CommandText = "SELECT payload FROM runs WHERE id=$id"; cmd.Parameters.AddWithValue("$id", id);
            return cmd.ExecuteScalar() is string payload ? JsonSerializer.Deserialize<UatRun>(payload, AppJson.Options)! : throw new ArgumentException("Unknown run.");
        }
    }
    private void Save(UatRun run, string? lease = null, DateTimeOffset? expires = null)
    {
        using var db = Open(); using var cmd = db.CreateCommand();
        cmd.CommandText = "INSERT INTO runs(id,payload,lease,lease_expires) VALUES($id,$payload,$lease,$expires) ON CONFLICT(id) DO UPDATE SET payload=$payload,lease=$lease,lease_expires=$expires";
        cmd.Parameters.AddWithValue("$id", run.Id);
        cmd.Parameters.AddWithValue("$payload", JsonSerializer.Serialize(run, AppJson.Options));
        cmd.Parameters.AddWithValue("$lease", (object?)lease ?? DBNull.Value); cmd.Parameters.AddWithValue("$expires", (object?)expires?.ToString("O") ?? DBNull.Value); cmd.ExecuteNonQuery();
    }
    internal UatRun Queue(QueueDefinition verified, bool qualification = false, bool docked = false, bool stepByStep = false)
    {
        lock (gate)
        {
            if (stepByStep && !docked) throw new ArgumentException("Step-by-step runs require the docked browser.");
            var current = QueueDefinitionFor(verified.Test.Id, qualification);
            if (current.Target != verified.Target || current.Revision != verified.Revision || !ReferenceEquals(current.Manifest, verified.Manifest) ||
                ApplicationManifests.Digest(current.Test) != ApplicationManifests.Digest(verified.Test))
                throw new ArgumentException("The application setup or workflow changed during preflight. Check it again before running.");
            var (test, manifest, target, revision, key) = current;
            var targeted = ApplicationManifests.NeedsTarget(manifest);
            if (test.Readiness == "draft" || !Manifests.Supports(test.ApplicationId, test.Adapter) ||
                (targeted && target?.ApplicationId != test.ApplicationId))
                throw new ArgumentException("This test needs an application adapter before it can run.");
            if (targeted) ApplicationSetup.Validate(target!, manifest);
            ApplicationSetup.ValidateWorkflowTarget(test, target);
            var id = Guid.NewGuid().ToString("N");
            var run = new UatRun(id, test.Id, test.ApplicationId, "queued", "pending",
                DateTimeOffset.UtcNow, null, null, $"uat-{id}", null, null, [], null, null, test, targeted ? target : null, Docked: docked, StepByStep: stepByStep,
                DefinitionRevision: revision, QualificationKey: key);
            run = run with { Configuration = Manifests.Freeze(run) };
            Save(run); return run;
        }
    }
    public RunLease? Claim(WorkerClaimRequest? request)
    {
        lock (gate)
        {
            Sweep();
            using var db = Open(); using var cmd = db.CreateCommand();
            var worker = request?.Execution;
            cmd.CommandText = """
                SELECT payload FROM runs WHERE json_extract(payload,'$.status')='queued'
                AND (COALESCE(json_extract(payload,'$.stepByStep'),0)=0 OR $steps=1)
                AND (json_extract(payload,'$.configuration') IS NULL OR
                     (json_extract(payload,'$.configuration.version')=$configuration AND
                      (json_extract(payload,'$.configuration.requiredEngineDigest') IS NULL OR json_extract(payload,'$.configuration.requiredEngineDigest')=$engine)))
                AND (json_extract(payload,'$.configuration.manifest.runtime.version') IS NULL OR json_extract(payload,'$.configuration.manifest.runtime.version')=$runtime)
                AND (json_extract(payload,'$.testSnapshot.adapter') IS NOT 'configured-v2' OR $workflow=1)
                AND (COALESCE(json_extract(payload,'$.testSnapshot.adapter'),'') != 'declarative-v1' OR json_extract(payload,'$.testSnapshot.implementation.engineDigest')=$engine)
                ORDER BY rowid LIMIT 1
                """;
            cmd.Parameters.AddWithValue("$steps", request?.SupportsStepControl == true ? 1 : 0);
            cmd.Parameters.AddWithValue("$configuration", ApplicationManifests.WorkerSupported(worker) ? ApplicationManifests.SnapshotVersion : DBNull.Value);
            cmd.Parameters.AddWithValue("$engine", WorkflowContract.Digest(request?.WorkflowEngineDigest) ? request!.WorkflowEngineDigest : DBNull.Value);
            cmd.Parameters.AddWithValue("$runtime", worker?.RuntimeContractVersion == RuntimeConfiguration.Version ? RuntimeConfiguration.Version : DBNull.Value);
            cmd.Parameters.AddWithValue("$workflow", ApplicationManifests.ConfiguredWorkerSupported(worker) ? 1 : 0);
            var run = cmd.ExecuteScalar() is string payload ? JsonSerializer.Deserialize<UatRun>(payload, AppJson.Options) : null;
            if (run is null) return null;
            if (run.Configuration is { } snapshot) ApplicationManifests.RequireWorker(snapshot, worker);
            run = run with { Status = "running", StartedAt = DateTimeOffset.UtcNow, Worker = ApplicationManifests.WorkerSupported(worker) ? worker : null };
            var lease = Guid.NewGuid().ToString("N"); Save(run, lease, DateTimeOffset.UtcNow.AddSeconds(45));
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
            var run = RequireRunLease(id, request.Lease);
            if (request.Status is not ("passed" or "failed" or "interrupted" or "cancelled")) throw new ArgumentException("Invalid result status.");
            if (request.Status == "cancelled" && !run.CancelRequested) throw new ArgumentException("Cancellation was not requested.");
            if (run.CancelRequested) request = request with { Status = "cancelled", Error = "Cancelled by the local user." };
            var steps = request.Steps ?? [];
            if (steps.Select(s => s.StepId).Distinct().Count() != steps.Count ||
                steps.Any(s => !run.TestSnapshot.Steps.Any(t => t.Id == s.StepId) || s.Status is not ("passed" or "failed")))
                throw new ArgumentException("Invalid step results.");
            foreach (var step in steps)
            {
                ValidateEvidence(run.Id, step.Screenshot);
                ConfiguredWorkflows.ValidateObservations(run, step);
            }
            ValidateEvidence(run.Id, request.Trace);
            if (request.Status == "passed" && (steps.Count != run.TestSnapshot.Steps.Count ||
                steps.Any(s => s.Status != "passed" || s.Screenshot is null) || request.Trace is null ||
                string.IsNullOrWhiteSpace(request.BuildVersion) || string.IsNullOrWhiteSpace(request.BaseUrl)))
                throw new ArgumentException("Passing runs require every step, screenshots, trace and tested build identity.");
            var identity = request.Status == "passed" ? ApplicationManifests.ValidateResult(run, request) : request.Identity is { } observed ? observed with { Resources = null } : null;
            RuntimeConfiguration.ValidateResult(run.Configuration?.Manifest.Runtime, request.Runtime, request.Status == "passed");
            run = run with { Status = request.Status, CompletedAt = DateTimeOffset.UtcNow,
                BuildVersion = request.BuildVersion, BaseUrl = request.BaseUrl, Steps = steps,
                Trace = request.Trace, Error = request.Error, Identity = identity, Runtime = request.Runtime };
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
        var run = Get(id); if (run.EvidenceRetiredAt is not null) return null; var reference = $"{id}/{file}";
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
            EnsureNoEvidenceCleanup(id);
            if (run.Acceptance == acceptance) return run;
            using var db = Open(); using var transaction = db.BeginTransaction();
            using var cmd = db.CreateCommand(); cmd.Transaction = transaction;
            cmd.CommandText = "UPDATE runs SET payload=$payload WHERE id=$id";
            cmd.Parameters.AddWithValue("$id", id); cmd.Parameters.AddWithValue("$payload", JsonSerializer.Serialize(run with { Acceptance = acceptance }, AppJson.Options)); cmd.ExecuteNonQuery();
            Audit(db, transaction, run, "review", acceptance); transaction.Commit(); return Get(id);
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
            EnsureNoEvidenceCleanup(id);
            var step = run.TestSnapshot.Steps.FirstOrDefault(s => s.Id == request.StepId)
                ?? throw new ArgumentException("Unknown test step.");
            if (string.IsNullOrWhiteSpace(request.Comment) || string.IsNullOrWhiteSpace(request.RequestedOutcome) ||
                request.Comment.Length > 8000 || request.RequestedOutcome.Length > 8000)
                throw new ArgumentException("Provide feedback and a requested outcome (up to 8000 characters each).");
            var screenshot = run.Steps.FirstOrDefault(s => s.StepId == step.Id)?.Screenshot;
            var prompt = new StringBuilder()
                .AppendLine($"Application: {run.ApplicationId}\nTest: {run.TestSnapshot.Title} ({run.TestId})")
                .AppendLine($"Run: {run.Id}\nTested build: {run.BuildVersion ?? "unavailable"}\nEnvironment: {run.BaseUrl ?? "unavailable"}")
                .AppendLine($"Frozen manifest: {run.Configuration?.ManifestDigest ?? "not recorded"}\nFrozen workflow: {run.Configuration?.WorkflowDigest ?? "not recorded"}\nWorker engine: {(run.TestSnapshot.Workflow is null ? run.Worker?.EngineDigest : run.Worker?.ConfiguredWorkflowDigest) ?? "not recorded"}")
                .AppendLine($"Manifest revision: {run.Configuration?.Manifest.Revision.ToString() ?? "not recorded"}\nImported workflow revision: {run.DefinitionRevision?.ToString() ?? "not applicable"}")
                .AppendLine($"Execution: {(run.StepByStep ? "step by step" : "automatic")}{(run.AssistedSteps is { Count: > 0 } ? $"; manual interaction requested before steps {string.Join(", ", run.AssistedSteps)} (see trace)" : "")}")
                .AppendLine($"Fixture: {run.FixtureId}\nStep: {step.Title} ({step.Id})\nExpected: {step.Expected}")
                .AppendLine($"Evidence scope: {run.Identity?.EvidenceKind ?? (run.ApplicationId == "getright" ? "demo" : "unverified")}\nTest account: {run.Identity?.UserId ?? "unavailable"}\nDocument: {run.Identity?.DocumentId ?? "unavailable"}\nCompany: {run.Identity?.CompanyId ?? "unavailable"}\nIsolation reference company: {run.Identity?.IsolationCompanyId ?? "unavailable"}")
                .AppendLine($"Source revision from build receipt: {run.Target?.SourceCommit ?? "not supplied"}\nSource had local changes: {(run.Target?.SourceCommit is null ? "not recorded" : run.Target.SourceWasDirty.ToString())}")
                .AppendLine($"Account roles: {string.Join(", ", run.Identity?.Roles ?? [])}")
                .AppendLine($"Tested resources: {string.Join(", ", (run.Identity?.Resources ?? []).Select(resource =>
                    resource.ScopeId is null ? $"{resource.Kind} {resource.Id}" : $"{resource.Kind} {resource.Id} (scope {resource.ScopeId})"))}")
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
            cmd.ExecuteNonQuery(); Audit(db, transaction, run, "feedback", "improvements-requested", feedback.Id); transaction.Commit(); return feedback;
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
            ApplicationSetup.Validate(profile, Manifests.Get(profile.ApplicationId));
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
