using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Data.Sqlite;

namespace Getright.Dashboard;

public record ImprovementJob(string Id, string OriginalRunId, string FeedbackId, string ApplicationId,
    string Prompt, int Revision, string Status, DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt,
    string? StartBlocker, string? BaseCommit = null, string? ResultCommit = null,
    string? WorktreePath = null, string? ThreadId = null, string? BuildVersion = null,
    string? RerunId = null, string? Summary = null, string? Error = null, bool CancelRequested = false);
public record JobEvent(long Sequence, DateTimeOffset CreatedAt, string Stage, string Message);
public record CreateJobRequest(string RunId, string FeedbackId);
public record EditJobRequest(string Prompt, int Revision);
public record StartJobRequest(int Revision);
public record JobLeaseRequest(string Lease);
public record JobClaim(ImprovementJob Job, UatRun OriginalRun, string Lease);
public record JobReport(string Lease, string Stage, string Message, string? WorktreePath = null,
    string? ThreadId = null, string? ResultCommit = null, string? BuildVersion = null, string? Summary = null);
public record JobFinish(string Lease, string Status, string? Error = null);
public record JobRerunRequest(string Lease, ApplicationProfile Target);
public static class JobStates
{
    public static bool Active(string status) => status is "preparing" or "implementing" or "building" or "launching" or "rerunning";
    public static bool Hash(string? value) => value is not null && Regex.IsMatch(value, "^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$");
}

public sealed partial class RunStore
{
    private List<ImprovementJob> ReadJobs()
    {
        using var db = Open(); using var cmd = db.CreateCommand();
        cmd.CommandText = "SELECT payload FROM improvement_jobs ORDER BY rowid DESC";
        using var reader = cmd.ExecuteReader(); var jobs = new List<ImprovementJob>();
        while (reader.Read()) jobs.Add(JsonSerializer.Deserialize<ImprovementJob>(reader.GetString(0), AppJson.Options)!);
        return jobs;
    }
    public List<ImprovementJob> Jobs()
    {
        lock (gate) { ExpireJobs(); return ReadJobs(); }
    }
    private ImprovementJob ReadJob(string id) => ReadJobs().FirstOrDefault(j => j.Id == id)
        ?? throw new ArgumentException("Unknown improvement job.");
    public ImprovementJob Job(string id) { lock (gate) { ExpireJobs(); return ReadJob(id); } }
    private void SaveJob(ImprovementJob job, string? lease = null, DateTimeOffset? expires = null)
    {
        using var db = Open(); using var cmd = db.CreateCommand();
        cmd.CommandText = "INSERT INTO improvement_jobs(id,run_id,feedback_id,payload,lease,lease_expires) VALUES($id,$run,$feedback,$payload,$lease,$expires) ON CONFLICT(id) DO UPDATE SET payload=$payload,lease=$lease,lease_expires=$expires";
        cmd.Parameters.AddWithValue("$id", job.Id); cmd.Parameters.AddWithValue("$run", job.OriginalRunId);
        cmd.Parameters.AddWithValue("$feedback", job.FeedbackId); cmd.Parameters.AddWithValue("$payload", JsonSerializer.Serialize(job, AppJson.Options));
        cmd.Parameters.AddWithValue("$lease", (object?)lease ?? DBNull.Value);
        cmd.Parameters.AddWithValue("$expires", (object?)expires?.ToString("O") ?? DBNull.Value);
        cmd.ExecuteNonQuery();
    }
    private void Event(ImprovementJob job, string message)
    {
        using var db = Open(); using var cmd = db.CreateCommand();
        cmd.CommandText = "INSERT INTO job_events(job_id,created_at,stage,message) VALUES($job,$at,$stage,$message)";
        cmd.Parameters.AddWithValue("$job", job.Id); cmd.Parameters.AddWithValue("$at", DateTimeOffset.UtcNow.ToString("O"));
        cmd.Parameters.AddWithValue("$stage", job.Status); cmd.Parameters.AddWithValue("$message", message);
        cmd.ExecuteNonQuery();
    }
    private static string? Blocker(UatRun run)
    {
        if (!ApplicationSetup.Supported(run.ApplicationId, run.TestSnapshot.Adapter))
            return "This workflow does not have an implementation adapter.";
        if (run.Target is not { } target || !JobStates.Hash(target.SourceCommit) || target.SourceWasDirty)
            return "Run a clean committed application build and import its build receipt before implementing. This run has no reproducible clean source revision.";
        if (run.BuildVersion != target.ExpectedBuildVersion || run.Identity?.UserId != target.ExpectedUserId || run.Identity.EvidenceKind != "live-application")
            return "This run did not verify the configured application build and account.";
        return null;
    }
    public ImprovementJob CreateJob(string runId, string feedbackId)
    {
        lock (gate)
        {
            var run = Get(runId);
            var feedback = FeedbackFor(runId).FirstOrDefault(f => f.Id == feedbackId) ?? throw new ArgumentException("Unknown feedback for this run.");
            var now = DateTimeOffset.UtcNow;
            var job = new ImprovementJob(Guid.NewGuid().ToString("N"), runId, feedbackId, run.ApplicationId,
                feedback.Prompt.ReplaceLineEndings("\n"), 1, "draft", now, now, Blocker(run), run.Target?.SourceCommit);
            SaveJob(job); Event(job, "Task draft created from the original feedback and frozen run evidence."); return job;
        }
    }
    public ImprovementJob EditJob(string id, EditJobRequest request)
    {
        lock (gate)
        {
            var job = Job(id);
            if (job.Status != "draft" || job.Revision != request.Revision) throw new ArgumentException("The task changed or is no longer a draft. Reload before editing.");
            if (string.IsNullOrWhiteSpace(request.Prompt) || request.Prompt.Length > 24000) throw new ArgumentException("Provide a task prompt up to 24000 characters.");
            job = job with { Prompt = request.Prompt.ReplaceLineEndings("\n").Trim(), Revision = job.Revision + 1, UpdatedAt = DateTimeOffset.UtcNow };
            SaveJob(job); Event(job, "Task draft saved."); return job;
        }
    }
    public ImprovementJob StartJob(string id, int revision)
    {
        lock (gate)
        {
            var job = Job(id);
            if (job.Status != "draft" || job.Revision != revision) throw new ArgumentException("The task changed or has already started. Reload before implementing.");
            if (job.StartBlocker is not null) throw new ArgumentException(job.StartBlocker);
            job = job with { Status = "queued", UpdatedAt = DateTimeOffset.UtcNow, Revision = job.Revision + 1 };
            SaveJob(job); Event(job, "Implementation explicitly requested. Waiting for the local worker."); return job;
        }
    }
    private void ExpireJobs()
    {
        using var db = Open(); using var cmd = db.CreateCommand();
        cmd.CommandText = "SELECT id FROM improvement_jobs WHERE lease_expires IS NOT NULL AND lease_expires < $now";
        cmd.Parameters.AddWithValue("$now", DateTimeOffset.UtcNow.ToString("O"));
        using var reader = cmd.ExecuteReader(); var ids = new List<string>();
        while (reader.Read()) ids.Add(reader.GetString(0));
        reader.Close();
        foreach (var id in ids)
        {
            var job = ReadJob(id);
            if (JobStates.Active(job.Status)) EndJob(job, "interrupted", "The worker lease expired. The worktree is retained; create a new job to retry.");
        }
    }
    public JobClaim? ClaimJob()
    {
        lock (gate)
        {
            ExpireJobs(); var job = ReadJobs().LastOrDefault(j => j.Status == "queued");
            if (job is null) return null;
            var lease = Guid.NewGuid().ToString("N");
            job = job with { Status = "preparing", UpdatedAt = DateTimeOffset.UtcNow };
            SaveJob(job, lease, DateTimeOffset.UtcNow.AddSeconds(45)); Event(job, "Worker claimed the implementation job.");
            return new(job, Get(job.OriginalRunId), lease);
        }
    }
    private ImprovementJob RequireJobLease(string id, string lease)
    {
        ExpireJobs(); var job = ReadJob(id);
        using var db = Open(); using var cmd = db.CreateCommand();
        cmd.CommandText = "SELECT lease FROM improvement_jobs WHERE id=$id"; cmd.Parameters.AddWithValue("$id", id);
        if (!JobStates.Active(job.Status) || string.IsNullOrWhiteSpace(lease) || cmd.ExecuteScalar() as string != lease)
            throw new ArgumentException("The implementation worker lease is no longer valid.");
        return job;
    }
    public ImprovementJob HeartbeatJob(string id, string lease)
    {
        lock (gate)
        {
            var job = RequireJobLease(id, lease); SaveJob(job, lease, DateTimeOffset.UtcNow.AddSeconds(45)); return job;
        }
    }
    public ImprovementJob ReportJob(string id, JobReport request)
    {
        lock (gate)
        {
            var job = RequireJobLease(id, request.Lease);
            if (job.CancelRequested) throw new ArgumentException("Cancellation was requested for this job.");
            var next = job.Status switch { "preparing" => "implementing", "implementing" => "building", "building" => "launching", _ => job.Status };
            if (request.Stage != job.Status && request.Stage != next) throw new ArgumentException("Invalid implementation stage transition.");
            if (string.IsNullOrWhiteSpace(request.Message) || request.Message.Length > 4000 || request.Summary?.Length > 8000 || request.ThreadId?.Length > 200 || request.WorktreePath?.Length > 2000 || request.BuildVersion?.Length > 150)
                throw new ArgumentException("Implementation event fields are missing or too long.");
            if (request.ResultCommit is not null && (!JobStates.Hash(request.ResultCommit) || request.ResultCommit == job.BaseCommit || (job.ResultCommit is not null && request.ResultCommit != job.ResultCommit)))
                throw new ArgumentException("The result must be a distinct, stable Git commit.");
            if (job.WorktreePath is not null && request.WorktreePath is not null && job.WorktreePath != request.WorktreePath) throw new ArgumentException("The worktree cannot change during a job.");
            if (job.ThreadId is not null && request.ThreadId is not null && job.ThreadId != request.ThreadId) throw new ArgumentException("The Codex thread cannot change during a job.");
            if (job.BuildVersion is not null && request.BuildVersion is not null && job.BuildVersion != request.BuildVersion) throw new ArgumentException("The build version cannot change during a job.");
            if (request.Stage is "building" or "launching" && (request.ResultCommit ?? job.ResultCommit) is null) throw new ArgumentException("Record the resulting commit before building.");
            if (request.Stage is "building" or "launching" && (string.IsNullOrWhiteSpace(request.ThreadId ?? job.ThreadId) || string.IsNullOrWhiteSpace(request.WorktreePath ?? job.WorktreePath)))
                throw new ArgumentException("Record the Codex thread and worktree before building.");
            if (request.Stage == "launching" && string.IsNullOrWhiteSpace(request.BuildVersion ?? job.BuildVersion)) throw new ArgumentException("Record the unique build version before launching.");
            job = job with { Status = request.Stage, UpdatedAt = DateTimeOffset.UtcNow,
                WorktreePath = request.WorktreePath ?? job.WorktreePath, ThreadId = request.ThreadId ?? job.ThreadId,
                ResultCommit = request.ResultCommit ?? job.ResultCommit, BuildVersion = request.BuildVersion ?? job.BuildVersion,
                Summary = request.Summary ?? job.Summary };
            SaveJob(job, request.Lease, DateTimeOffset.UtcNow.AddSeconds(45)); Event(job, request.Message); return job;
        }
    }
    private ImprovementJob EndJob(ImprovementJob job, string status, string? error)
    {
        if (job.RerunId is { } id)
        {
            var run = Get(id);
            if (run.Status is "queued" or "running") Save(run with { Status = "interrupted", CompletedAt = DateTimeOffset.UtcNow, Error = error ?? "The implementation job stopped." });
        }
        job = job with { Status = status, UpdatedAt = DateTimeOffset.UtcNow, Error = error };
        SaveJob(job); Event(job, error ?? "Build and regression test completed. The new run awaits a human review."); return job;
    }
    public ImprovementJob CancelJob(string id)
    {
        lock (gate)
        {
            var job = Job(id);
            if (job.CancelRequested) return job;
            if (job.Status is "draft" or "queued") return EndJob(job with { CancelRequested = true }, "cancelled", "Cancelled before execution.");
            if (!JobStates.Active(job.Status)) return job;
            // Keep the valid lease while the worker stops its owned processes.
            job = job with { CancelRequested = true, UpdatedAt = DateTimeOffset.UtcNow };
            using var db = Open(); using var cmd = db.CreateCommand();
            cmd.CommandText = "UPDATE improvement_jobs SET payload=$payload WHERE id=$id";
            cmd.Parameters.AddWithValue("$payload", JsonSerializer.Serialize(job, AppJson.Options)); cmd.Parameters.AddWithValue("$id", id); cmd.ExecuteNonQuery();
            Event(job, "Cancellation requested. Waiting for the worker to stop its processes."); return job;
        }
    }
    public ImprovementJob FinishJob(string id, JobFinish request)
    {
        lock (gate)
        {
            var job = RequireJobLease(id, request.Lease);
            if (request.Status is not ("awaiting-review" or "failed" or "cancelled" or "interrupted") || request.Error?.Length > 8000)
                throw new ArgumentException("Invalid implementation result.");
            if (request.Status == "awaiting-review" && (job.CancelRequested || job.Status != "rerunning" || job.RerunId is null || Get(job.RerunId).Status != "passed"))
                throw new ArgumentException("A successful linked regression run is required before review.");
            if (request.Status == "cancelled" && !job.CancelRequested) throw new ArgumentException("Cancellation has not been requested.");
            return EndJob(job, job.CancelRequested ? "cancelled" : request.Status, request.Error);
        }
    }
    public RunLease CreateJobRerun(string id, JobRerunRequest request)
    {
        lock (gate)
        {
            var job = RequireJobLease(id, request.Lease); var original = Get(job.OriginalRunId);
            if (job.Status != "launching" || job.CancelRequested || job.RerunId is not null) throw new ArgumentException("This job cannot start another regression run.");
            ApplicationSetup.Validate(request.Target);
            if (request.Target.ApplicationId != job.ApplicationId || request.Target.SourceCommit != job.ResultCommit || request.Target.SourceWasDirty ||
                request.Target.ExpectedBuildVersion != job.BuildVersion || request.Target.BaseUrl == original.BaseUrl)
                throw new ArgumentException("The regression target must identify the clean resulting commit on its own local instance.");
            var now = DateTimeOffset.UtcNow; var runId = Guid.NewGuid().ToString("N"); var runLease = Guid.NewGuid().ToString("N");
            var run = new UatRun(runId, original.TestId, original.ApplicationId, "running", "pending", now, now, null,
                $"uat-{runId}", null, null, [], null, null, original.TestSnapshot, request.Target, null, job.Id, original.Id);
            job = job with { Status = "rerunning", RerunId = runId, UpdatedAt = now };
            using var db = Open(); using var transaction = db.BeginTransaction(); using var cmd = db.CreateCommand(); cmd.Transaction = transaction;
            cmd.CommandText = "INSERT INTO runs(id,payload,lease) VALUES($run,$runPayload,$runLease); UPDATE improvement_jobs SET payload=$jobPayload,lease_expires=$expires WHERE id=$job";
            cmd.Parameters.AddWithValue("$run", run.Id); cmd.Parameters.AddWithValue("$runPayload", JsonSerializer.Serialize(run, AppJson.Options));
            cmd.Parameters.AddWithValue("$runLease", runLease); cmd.Parameters.AddWithValue("$jobPayload", JsonSerializer.Serialize(job, AppJson.Options));
            cmd.Parameters.AddWithValue("$expires", now.AddSeconds(45).ToString("O")); cmd.Parameters.AddWithValue("$job", id);
            cmd.ExecuteNonQuery(); transaction.Commit(); Event(job, "Changed build verified. Rerunning the original frozen test with fresh data."); return new(run, runLease);
        }
    }
    public List<JobEvent> JobEvents(string id, long after = 0)
    {
        lock (gate)
        {
            _ = Job(id); using var db = Open(); using var cmd = db.CreateCommand();
            cmd.CommandText = "SELECT sequence,created_at,stage,message FROM job_events WHERE job_id=$id AND sequence>$after ORDER BY sequence LIMIT 200";
            cmd.Parameters.AddWithValue("$id", id); cmd.Parameters.AddWithValue("$after", after);
            using var reader = cmd.ExecuteReader(); var result = new List<JobEvent>();
            while (reader.Read()) result.Add(new(reader.GetInt64(0), DateTimeOffset.Parse(reader.GetString(1)), reader.GetString(2), reader.GetString(3)));
            return result;
        }
    }
    public string? JobArtifactPath(string id, string file)
    {
        _ = Job(id);
        return file is "codex.log" or "build.log" or "launch.log" or "diff.patch" or "summary.json"
            ? Path.Combine(DataPath, "jobs", id, file) : null;
    }
}
