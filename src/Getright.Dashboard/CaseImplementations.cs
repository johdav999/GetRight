using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using Microsoft.Data.Sqlite;

namespace Getright.Dashboard;

public record WorkflowAction(string Kind, string? Selector = null, string? Value = null);
public record WorkflowStep(string StepId, List<WorkflowAction> Actions);
public record WorkflowPlan(int Version, string Fixture, string EntryPath, string ReviewPath, List<WorkflowStep> Steps);
public record WorkflowImplementation(string JobId, string DefinitionDigest, string PlanJson, string PlanDigest,
    string EngineDigest, string PlatformBaseCommit, string ResultCommit, string? ApplicationSourceCommit,
    List<string> ValidationRunIds, DateTimeOffset VerifiedAt);
public record CaseImplementationJob(string Id, string TestId, string ApplicationId, string Status,
    UatTest TestSnapshot, string DefinitionDigest, ApplicationProfile? ApprovedTarget,
    DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt, string? PlatformBaseCommit = null,
    string? WorktreePath = null, string? ApplicationWorktree = null, string? ThreadId = null,
    string? ResultCommit = null, string? EngineDigest = null, string? PlanJson = null, string? PlanDigest = null,
    ApplicationProfile? ValidationTarget = null, List<string>? ValidationRunIds = null,
    string? Error = null, bool CancelRequested = false);
public record CaseImplementationClaim(CaseImplementationJob Job, string Lease);
public record ApproveCaseRequest(string DefinitionDigest);
public record CaseImplementationReport(string Lease, string Stage, string Message,
    string? PlatformBaseCommit = null, string? WorktreePath = null, string? ApplicationWorktree = null,
    string? ThreadId = null, string? ResultCommit = null, string? EngineDigest = null,
    string? PlanJson = null, ApplicationProfile? ValidationTarget = null);
public record CaseValidationRequest(string Lease, int Ordinal);
public record CaseImplementationFinish(string Lease, string Status, string? Error = null);
public record WorkerClaimRequest(string? WorkflowEngineDigest = null);

public static class WorkflowContract
{
    public const string Adapter = "declarative-v1";
    public static string Fixture(string application) => application switch {
        "getright" => "getright-note", "writerapp" => "writerapp-document", "virtual-company" => "virtual-company-test-company",
        _ => throw new ArgumentException("This application has no isolated fixture adapter.") };
    public static bool Digest(string? value) => value is not null && Regex.IsMatch(value, "^[a-f0-9]{64}$");
    public static string Hash(string value) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(value)));
    public static void Path(string? value, bool templates)
    {
        RunStore.RequireText(value, "Application path", 1000);
        if (!value!.StartsWith('/') || value.StartsWith("//") || value.Contains('\\') || value.Contains('\r') || value.Contains('\n') ||
            (!templates && value.Contains("{{"))) throw new ArgumentException("Use a relative application path; review paths cannot contain fixture placeholders.");
        if (new Uri(new Uri("http://127.0.0.1"), value).Host != "127.0.0.1") throw new ArgumentException("The path must stay on the isolated application origin.");
        if (templates && Regex.Matches(value, "\\{\\{(.*?)\\}\\}").Any(m => m.Groups[1].Value is not ("fixtureId" or "unique" or "companyId" or "documentId" or "email")))
            throw new ArgumentException("Unknown fixture placeholder.");
    }
    public static WorkflowPlan Validate(UatTest test, string json)
    {
        RunStore.RequireText(json, "Workflow plan", 65536);
        WorkflowPlan plan;
        try { plan = JsonSerializer.Deserialize<WorkflowPlan>(json, new JsonSerializerOptions(AppJson.Options) { UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow }) ?? throw new JsonException(); }
        catch (JsonException) { throw new ArgumentException("The implementation must be a valid bounded workflow plan, not executable code."); }
        if (plan.Version != 1 || plan.Fixture != Fixture(test.ApplicationId) || plan.Steps is null ||
            !plan.Steps.Select(s => s?.StepId).SequenceEqual(test.Steps.Select(s => s.Id))) throw new ArgumentException("The plan must implement every frozen step in its original order using this application's fixture.");
        Path(plan.EntryPath, true); Path(plan.ReviewPath, false);
        var count = 0;
        foreach (var step in plan.Steps)
        {
            if (step is null || step.Actions is null || step.Actions.Count is < 1 or > 30 || !step.Actions.Any(a => a?.Kind?.StartsWith("expect-", StringComparison.Ordinal) == true))
                throw new ArgumentException("Every step needs bounded actions and an observable assertion.");
            count += step.Actions.Count;
            foreach (var action in step.Actions)
            {
                if (action is null || action.Kind is not ("goto" or "reload" or "fill" or "click" or "check" or "uncheck" or "select" or
                    "expect-visible" or "expect-hidden" or "expect-text" or "expect-value" or "expect-checked" or "expect-unchecked" or "expect-enabled" or "expect-disabled" or "expect-count" or "expect-url"))
                    throw new ArgumentException("The plan contains an unsupported action. JavaScript, shell commands and arbitrary HTTP requests are not allowed.");
                if (action.Kind is "goto" or "expect-url") Path(action.Value, true);
                else if (action.Kind != "reload") RequireSelector(action.Selector);
                if (action.Value?.Length > 8000) throw new ArgumentException("An action value is too long.");
                if (action.Kind == "expect-count" && (!int.TryParse(action.Value, out var number) || number is < 0 or > 1000)) throw new ArgumentException("Use an expected element count between 0 and 1000.");
                if (action.Kind is "fill" or "select" or "expect-text" or "expect-value" && action.Value is null) throw new ArgumentException("This action requires a value.");
                foreach (var value in new[] { action.Selector, action.Value }.Where(v => v is not null))
                    if (Regex.Matches(value!, "\\{\\{(.*?)\\}\\}").Any(m => m.Groups[1].Value is not ("fixtureId" or "unique" or "companyId" or "documentId" or "email"))) throw new ArgumentException("Unknown fixture placeholder.");
            }
        }
        if (count > 120) throw new ArgumentException("A workflow supports at most 120 actions.");
        return plan;
    }
    private static void RequireSelector(string? selector) => RunStore.RequireText(selector, "Element selector", 500);
}

public static class CaseImplementationStates
{
    public static bool Active(string status) => status is "preparing" or "building" or "implementing" or "validating";
}

public sealed partial class RunStore
{
    public static string DefinitionDigest(UatTest test) => WorkflowContract.Hash(JsonSerializer.Serialize(new {
        test.Id, test.ApplicationId, test.Title, test.Purpose, test.Preconditions, test.ReviewQuestion, test.Steps
    }, AppJson.Options));
    private List<CaseImplementationJob> ReadCaseJobs(string suffix)
    {
        using var db = Open(); using var cmd = db.CreateCommand(); cmd.CommandText = "SELECT payload FROM case_implementation_jobs " + suffix;
        using var reader = cmd.ExecuteReader(); var jobs = new List<CaseImplementationJob>();
        while (reader.Read()) jobs.Add(JsonSerializer.Deserialize<CaseImplementationJob>(reader.GetString(0), AppJson.Options)!);
        return jobs;
    }
    private CaseImplementationJob ReadCaseJob(string id)
    {
        using var db = Open(); using var cmd = db.CreateCommand(); cmd.CommandText = "SELECT payload FROM case_implementation_jobs WHERE id=$id"; cmd.Parameters.AddWithValue("$id", id);
        return cmd.ExecuteScalar() is string payload ? JsonSerializer.Deserialize<CaseImplementationJob>(payload, AppJson.Options)! : throw new ArgumentException("Unknown test implementation job.");
    }
    public CaseImplementationJob CaseJob(string id) { lock (gate) { ExpireCaseJobs(); return ReadCaseJob(id); } }
    public List<CaseImplementationJob> LatestCaseJobs(IEnumerable<string> testIds)
    {
        lock (gate)
        {
            ExpireCaseJobs(); using var db = Open(); using var cmd = db.CreateCommand();
            cmd.CommandText = """
                SELECT payload FROM case_implementation_jobs WHERE rowid IN (
                    SELECT MAX(rowid) FROM case_implementation_jobs
                    WHERE test_id IN (SELECT value FROM json_each($tests)) GROUP BY test_id
                ) ORDER BY rowid DESC
                """;
            cmd.Parameters.AddWithValue("$tests", JsonSerializer.Serialize(testIds.Distinct()));
            using var reader = cmd.ExecuteReader(); var result = new List<CaseImplementationJob>();
            while (reader.Read()) result.Add(JsonSerializer.Deserialize<CaseImplementationJob>(reader.GetString(0), AppJson.Options)!);
            return result;
        }
    }
    public JobEvent? LatestCaseEvent(string id)
    {
        lock (gate)
        {
            _ = CaseJob(id); using var db = Open(); using var cmd = db.CreateCommand();
            cmd.CommandText = "SELECT sequence,created_at,stage,message FROM case_implementation_events WHERE job_id=$id ORDER BY sequence DESC LIMIT 1";
            cmd.Parameters.AddWithValue("$id", id); using var reader = cmd.ExecuteReader();
            return reader.Read() ? new(reader.GetInt64(0), DateTimeOffset.Parse(reader.GetString(1)), reader.GetString(2), reader.GetString(3)) : null;
        }
    }
    public List<CaseImplementationJob> CaseJobs(string? testId = null)
    {
        lock (gate)
        {
            ExpireCaseJobs(); using var db = Open(); using var cmd = db.CreateCommand();
            cmd.CommandText = "SELECT payload FROM case_implementation_jobs WHERE ($test IS NULL OR test_id=$test) ORDER BY rowid DESC LIMIT 100";
            cmd.Parameters.AddWithValue("$test", (object?)testId ?? DBNull.Value);
            using var reader = cmd.ExecuteReader(); var result = new List<CaseImplementationJob>();
            while (reader.Read()) result.Add(JsonSerializer.Deserialize<CaseImplementationJob>(reader.GetString(0), AppJson.Options)!);
            return result;
        }
    }
    private void SaveCaseJob(CaseImplementationJob job, string? lease = null, DateTimeOffset? expires = null)
    {
        using var db = Open(); using var cmd = db.CreateCommand();
        cmd.CommandText = "INSERT INTO case_implementation_jobs(id,test_id,payload,lease,lease_expires) VALUES($id,$test,$payload,$lease,$expires) ON CONFLICT(id) DO UPDATE SET payload=$payload,lease=$lease,lease_expires=$expires";
        cmd.Parameters.AddWithValue("$id", job.Id); cmd.Parameters.AddWithValue("$test", job.TestId); cmd.Parameters.AddWithValue("$payload", JsonSerializer.Serialize(job, AppJson.Options));
        cmd.Parameters.AddWithValue("$lease", (object?)lease ?? DBNull.Value); cmd.Parameters.AddWithValue("$expires", (object?)expires?.ToString("O") ?? DBNull.Value); cmd.ExecuteNonQuery();
    }
    private void CaseEvent(CaseImplementationJob job, string message)
    {
        using var db = Open(); using var cmd = db.CreateCommand();
        cmd.CommandText = "INSERT INTO case_implementation_events(job_id,created_at,stage,message) VALUES($id,$at,$stage,$message)";
        cmd.Parameters.AddWithValue("$id", job.Id); cmd.Parameters.AddWithValue("$at", DateTimeOffset.UtcNow.ToString("O")); cmd.Parameters.AddWithValue("$stage", job.Status); cmd.Parameters.AddWithValue("$message", message); cmd.ExecuteNonQuery();
    }
    public List<JobEvent> CaseEvents(string id, long after = 0)
    {
        lock (gate)
        {
            _ = CaseJob(id); using var db = Open(); using var cmd = db.CreateCommand();
            cmd.CommandText = "SELECT sequence,created_at,stage,message FROM case_implementation_events WHERE job_id=$id AND sequence>$after ORDER BY sequence LIMIT 200";
            cmd.Parameters.AddWithValue("$id", id); cmd.Parameters.AddWithValue("$after", after); using var reader = cmd.ExecuteReader(); var result = new List<JobEvent>();
            while (reader.Read()) result.Add(new(reader.GetInt64(0), DateTimeOffset.Parse(reader.GetString(1)), reader.GetString(2), reader.GetString(3))); return result;
        }
    }
    public CaseImplementationJob ApproveCase(string id, ApproveCaseRequest request, ApplicationProfile? approvedTarget)
    {
        lock (gate)
        {
            var test = Test(id);
            if (test.Readiness != "draft" && test.Implementation is null) throw new ArgumentException("This case already has a built-in adapter.");
            if (DefinitionDigest(test) != request.DefinitionDigest) throw new ArgumentException("The test case changed. Review the current steps before approving implementation.");
            _ = WorkflowContract.Fixture(test.ApplicationId);
            if (test.ApplicationId != "getright")
            {
                if (approvedTarget?.ApplicationId != test.ApplicationId) throw new ArgumentException("Configure the isolated application first.");
                ApplicationSetup.Validate(approvedTarget);
                if (!JobStates.Hash(approvedTarget.SourceCommit) || approvedTarget.SourceWasDirty) throw new ArgumentException("Import a clean committed application's launch receipt before implementing its test.");
            }
            if (CaseJobs(id).FirstOrDefault(j => j.Status == "queued" || CaseImplementationStates.Active(j.Status)) is { } active) return active;
            var now = DateTimeOffset.UtcNow;
            var job = new CaseImplementationJob(Guid.NewGuid().ToString("N"), id, test.ApplicationId, "queued",
                test with { Readiness = "draft", Adapter = null, Implementation = null }, request.DefinitionDigest, approvedTarget, now, now);
            SaveCaseJob(job); CaseEvent(job, "Test description approved for implementation. The case stays disabled until two isolated validation runs pass."); return job;
        }
    }
    public CaseImplementationClaim? ClaimCaseJob()
    {
        lock (gate)
        {
            ExpireCaseJobs(); var job = ReadCaseJobs("WHERE json_extract(payload,'$.status')='queued' ORDER BY rowid LIMIT 1").FirstOrDefault();
            if (job is null) return null;
            job = job with { Status = "preparing", UpdatedAt = DateTimeOffset.UtcNow }; var lease = Guid.NewGuid().ToString("N");
            SaveCaseJob(job, lease, DateTimeOffset.UtcNow.AddSeconds(45)); CaseEvent(job, "Implementation claimed by the local worker."); return new(job, lease);
        }
    }
    private CaseImplementationJob RequireCaseLease(string id, string lease)
    {
        ExpireCaseJobs(); var job = ReadCaseJob(id);
        using var db = Open(); using var cmd = db.CreateCommand(); cmd.CommandText = "SELECT lease FROM case_implementation_jobs WHERE id=$id"; cmd.Parameters.AddWithValue("$id", id);
        if (!CaseImplementationStates.Active(job.Status) || string.IsNullOrWhiteSpace(lease) || cmd.ExecuteScalar() as string != lease) throw new ArgumentException("The test implementation lease is no longer valid.");
        return job;
    }
    public CaseImplementationJob HeartbeatCaseJob(string id, string lease)
    { lock (gate) { var job = RequireCaseLease(id, lease); SaveCaseJob(job, lease, DateTimeOffset.UtcNow.AddSeconds(45)); return job; } }
    public CaseImplementationJob ReportCaseJob(string id, CaseImplementationReport request)
    {
        lock (gate)
        {
            var job = RequireCaseLease(id, request.Lease);
            var stages = new[] { "preparing", "building", "implementing", "validating" };
            if (!stages.Contains(request.Stage) || Array.IndexOf(stages, request.Stage) < Array.IndexOf(stages, job.Status)) throw new ArgumentException("Invalid test implementation stage.");
            RequireText(request.Message, "Progress message", 4000);
            static string? Keep(string? old, string? next) { if (old is not null && next is not null && old != next) throw new ArgumentException("Recorded implementation identities cannot change."); return old ?? next; }
            var target = job.ValidationTarget ?? request.ValidationTarget;
            if (request.ValidationTarget is { } supplied)
            {
                ApplicationSetup.Validate(supplied);
                if (supplied.ApplicationId != job.ApplicationId || supplied.SourceCommit != job.ApprovedTarget?.SourceCommit || supplied.SourceWasDirty ||
                    (job.ValidationTarget is not null && job.ValidationTarget != supplied)) throw new ArgumentException("Validation must use the approved clean application revision.");
            }
            job = job with { PlatformBaseCommit = Keep(job.PlatformBaseCommit, request.PlatformBaseCommit), WorktreePath = Keep(job.WorktreePath, request.WorktreePath),
                ApplicationWorktree = Keep(job.ApplicationWorktree, request.ApplicationWorktree), ThreadId = Keep(job.ThreadId, request.ThreadId), ResultCommit = Keep(job.ResultCommit, request.ResultCommit),
                EngineDigest = Keep(job.EngineDigest, request.EngineDigest), PlanJson = Keep(job.PlanJson, request.PlanJson), ValidationTarget = target };
            if (job.PlatformBaseCommit is not null && !JobStates.Hash(job.PlatformBaseCommit)) throw new ArgumentException("Invalid platform base commit.");
            if (job.ResultCommit is not null && (!JobStates.Hash(job.ResultCommit) || job.ResultCommit == job.PlatformBaseCommit)) throw new ArgumentException("Record a distinct implementation commit.");
            if (request.Stage != "preparing" && (!JobStates.Hash(job.PlatformBaseCommit) || string.IsNullOrWhiteSpace(job.WorktreePath))) throw new ArgumentException("Retain the dedicated worktree and its base commit before implementation.");
            if (request.Stage == "validating")
            {
                if (job.CancelRequested || !JobStates.Hash(job.ResultCommit) || !WorkflowContract.Digest(job.EngineDigest) || string.IsNullOrWhiteSpace(job.ThreadId) || job.PlanJson is null ||
                    (job.ApplicationId != "getright" && job.ValidationTarget is null)) throw new ArgumentException("Validation requires the committed plan, engine identity, Codex thread and isolated application build.");
                WorkflowContract.Validate(job.TestSnapshot, job.PlanJson);
                job = job with { PlanDigest = WorkflowContract.Hash(job.PlanJson) };
            }
            job = job with { Status = request.Stage, UpdatedAt = DateTimeOffset.UtcNow }; SaveCaseJob(job, request.Lease, DateTimeOffset.UtcNow.AddSeconds(45)); CaseEvent(job, request.Message); return job;
        }
    }
    public RunLease CreateCaseValidation(string id, CaseValidationRequest request)
    {
        lock (gate)
        {
            var job = RequireCaseLease(id, request.Lease); var previous = job.ValidationRunIds ?? [];
            if (job.Status != "validating" || job.CancelRequested || request.Ordinal != previous.Count + 1 || previous.Count >= 2 || previous.Any(run => Get(run).Status != "passed")) throw new ArgumentException("Validate twice in sequence; each previous run must pass first.");
            var binding = new WorkflowImplementation(job.Id, job.DefinitionDigest, job.PlanJson!, job.PlanDigest!, job.EngineDigest!, job.PlatformBaseCommit!, job.ResultCommit!, job.ApprovedTarget?.SourceCommit, [], DateTimeOffset.UtcNow);
            var runId = Guid.NewGuid().ToString("N"); var runLease = Guid.NewGuid().ToString("N"); var now = DateTimeOffset.UtcNow;
            var run = new UatRun(runId, job.TestId, job.ApplicationId, "running", "pending", now, now, null, $"uat-{runId}", null, null, [], null, null,
                job.TestSnapshot with { Adapter = WorkflowContract.Adapter, Readiness = "validating", Implementation = binding }, job.ValidationTarget, CaseImplementationJobId: job.Id);
            job = job with { ValidationRunIds = [.. previous, runId], UpdatedAt = now };
            using var db = Open(); using var transaction = db.BeginTransaction(); using var cmd = db.CreateCommand(); cmd.Transaction = transaction;
            cmd.CommandText = "INSERT INTO runs(id,payload,lease,lease_expires) VALUES($run,$payload,$lease,$expires); UPDATE case_implementation_jobs SET payload=$job WHERE id=$id";
            cmd.Parameters.AddWithValue("$run", runId); cmd.Parameters.AddWithValue("$payload", JsonSerializer.Serialize(run, AppJson.Options)); cmd.Parameters.AddWithValue("$lease", runLease); cmd.Parameters.AddWithValue("$expires", now.AddSeconds(45).ToString("O"));
            cmd.Parameters.AddWithValue("$job", JsonSerializer.Serialize(job, AppJson.Options)); cmd.Parameters.AddWithValue("$id", id); cmd.ExecuteNonQuery(); transaction.Commit();
            CaseEvent(job, $"Isolated validation {request.Ordinal}/2 started with a fresh fixture. Human acceptance remains pending."); return new(run, runLease);
        }
    }
    public CaseImplementationJob FinishCaseJob(string id, CaseImplementationFinish request)
    {
        lock (gate)
        {
            var job = RequireCaseLease(id, request.Lease);
            if (request.Status is not ("verified" or "failed" or "interrupted" or "cancelled")) throw new ArgumentException("Invalid implementation result.");
            if (request.Status == "verified")
            {
                var runs = (job.ValidationRunIds ?? []).Select(Get).ToList();
                if (job.CancelRequested || job.Status != "validating" || runs.Count != 2 || runs.Any(r => r.Status != "passed" || r.CaseImplementationJobId != id || r.TestSnapshot.Implementation?.PlanDigest != job.PlanDigest || r.TestSnapshot.Implementation?.EngineDigest != job.EngineDigest) ||
                    runs.Select(r => r.FixtureId).Distinct().Count() != 2 || DefinitionDigest(Test(job.TestId)) != job.DefinitionDigest) throw new ArgumentException("Only an unchanged case with two passing isolated validation runs can become runnable.");
                if (job.ApplicationId == "virtual-company" && runs.Select(r => r.Identity?.CompanyId).Distinct().Count() != 2) throw new ArgumentException("Validation must create two different isolated companies.");
                if (job.ApplicationId == "writerapp" && runs.Select(r => r.Identity?.DocumentId).Distinct().Count() != 2) throw new ArgumentException("Validation must create two different isolated documents.");
                var binding = new WorkflowImplementation(job.Id, job.DefinitionDigest, job.PlanJson!, job.PlanDigest!, job.EngineDigest!, job.PlatformBaseCommit!, job.ResultCommit!, job.ApprovedTarget?.SourceCommit, job.ValidationRunIds!, DateTimeOffset.UtcNow);
                job = job with { Status = "verified", UpdatedAt = DateTimeOffset.UtcNow };
                using var db = Open(); using var transaction = db.BeginTransaction(); using var cmd = db.CreateCommand(); cmd.Transaction = transaction;
                cmd.CommandText = "INSERT INTO case_bindings(test_id,job_id,payload) VALUES($test,$id,$binding) ON CONFLICT(test_id) DO UPDATE SET job_id=$id,payload=$binding; UPDATE case_implementation_jobs SET payload=$payload,lease=NULL,lease_expires=NULL WHERE id=$id";
                cmd.Parameters.AddWithValue("$test", job.TestId); cmd.Parameters.AddWithValue("$id", id); cmd.Parameters.AddWithValue("$binding", JsonSerializer.Serialize(binding, AppJson.Options)); cmd.Parameters.AddWithValue("$payload", JsonSerializer.Serialize(job, AppJson.Options)); cmd.ExecuteNonQuery(); transaction.Commit();
                CaseEvent(job, "Two isolated runs passed. The verified workflow is now runnable; application acceptance was not changed."); return job;
            }
            return EndCaseJob(job, job.CancelRequested ? "cancelled" : request.Status, request.Error);
        }
    }
    private CaseImplementationJob EndCaseJob(CaseImplementationJob job, string status, string? error)
    {
        foreach (var id in job.ValidationRunIds ?? [])
        {
            var run = Get(id);
            if (run.Status is "queued" or "running") Save(run with { Status = "interrupted", CompletedAt = DateTimeOffset.UtcNow, Error = error ?? "Test implementation stopped." });
        }
        job = job with { Status = status, Error = error?.Length > 8000 ? error[..8000] : error, UpdatedAt = DateTimeOffset.UtcNow }; SaveCaseJob(job); CaseEvent(job, job.Error ?? $"Implementation {status}."); return job;
    }
    public CaseImplementationJob CancelCaseJob(string id)
    {
        lock (gate)
        {
            var job = CaseJob(id);
            if (job.Status == "queued") return EndCaseJob(job with { CancelRequested = true }, "cancelled", "Cancelled before implementation.");
            if (CaseImplementationStates.Active(job.Status))
            {
                job = job with { CancelRequested = true, UpdatedAt = DateTimeOffset.UtcNow };
                using var db = Open(); using var cmd = db.CreateCommand(); cmd.CommandText = "UPDATE case_implementation_jobs SET payload=$payload WHERE id=$id";
                cmd.Parameters.AddWithValue("$id", id); cmd.Parameters.AddWithValue("$payload", JsonSerializer.Serialize(job, AppJson.Options)); cmd.ExecuteNonQuery();
            }
            return job;
        }
    }
    public UatTest DisableCase(string id)
    {
        lock (gate)
        {
            using var db = Open(); using var cmd = db.CreateCommand(); cmd.CommandText = "DELETE FROM case_bindings WHERE test_id=$id"; cmd.Parameters.AddWithValue("$id", id); cmd.ExecuteNonQuery(); return Test(id);
        }
    }
    private void ExpireCaseJobs()
    {
        foreach (var job in ReadCaseJobs($"WHERE lease_expires IS NOT NULL AND lease_expires < '{DateTimeOffset.UtcNow:O}'"))
            if (CaseImplementationStates.Active(job.Status)) EndCaseJob(job, "interrupted", "Test implementation worker lease expired. Its worktrees and evidence are retained.");
    }
    private void RecoverCaseJobs()
    {
        foreach (var job in ReadCaseJobs("WHERE json_extract(payload,'$.status') IN ('preparing','building','implementing','validating')"))
            EndCaseJob(job, "interrupted", "Dashboard restarted during test implementation. Retry the approved description in a new job.");
    }
}
