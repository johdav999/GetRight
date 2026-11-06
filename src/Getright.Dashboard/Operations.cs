using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace Getright.Dashboard;

public record PageResult<T>(List<T> Items, int Total, int Page, int PageSize, long Snapshot = 0);
public record ReviewEvent(long Sequence, DateTimeOffset CreatedAt, string Action, string Previous, string Current, string? FeedbackId);
public record CleanupCandidate(string Kind, string ResourceId, string Description, string Token, long? Bytes = null);
public record CleanupRequest(string Kind, string ResourceId, string Token, int RetentionDays = 30);
public record CleanupTask(string Id, string Kind, string ResourceId, string Status, DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt, string ApplicationId, string? WorktreePath = null, string? Commit = null, string? Error = null, BuildRecipeReference? Recipe = null);
public record CleanupClaim(CleanupTask Task, string Lease);
public record CleanupFinish(string Lease, string Status, string? Error = null);
public record CleanupBatch(List<CleanupCandidate> Items, int Page, bool HasMore);

public sealed partial class RunStore
{
    public void Sweep() { lock (gate) { ExpireCaseJobs(); ExpireRuns(); ExpireJobs(); ExpireCleanups(); } }
    private void ExpireRuns()
    {
        var now = DateTimeOffset.UtcNow.ToString("O");
        // The timestamp is generated locally, never from request text.
        foreach (var run in ReadRuns($"WHERE lease_expires IS NOT NULL AND lease_expires < '{now}' AND json_extract(payload,'$.status')='running'"))
            Save(run with { Status = "interrupted", CompletedAt = DateTimeOffset.UtcNow, Error = "The worker heartbeat expired. Queue a fresh run." });
    }
    private UatRun RequireRunLease(string id, string lease)
    {
        ExpireCaseJobs(); ExpireJobs(); var run = Get(id);
        if (run.Status != "running" || string.IsNullOrWhiteSpace(lease) || Lease(id) != lease)
            throw new ArgumentException("The worker lease is no longer valid.");
        return run;
    }
    public UatRun HeartbeatRun(string id, string lease)
    {
        lock (gate) { var run = RequireRunLease(id, lease); Save(run, lease, DateTimeOffset.UtcNow.AddSeconds(45)); return run; }
    }
    public UatRun CancelRun(string id)
    {
        lock (gate)
        {
            var run = Get(id);
            if (run.ImprovementJobId is not null) throw new ArgumentException("Cancel the owning improvement job to stop this regression run.");
            if (run.CaseImplementationJobId is not null) throw new ArgumentException("Cancel the owning test implementation job to stop its validation run.");
            if (run.Status == "queued") { run = run with { Status = "cancelled", CancelRequested = true, CompletedAt = DateTimeOffset.UtcNow, Error = "Cancelled before execution." }; Save(run); }
            else if (run.Status == "running")
            {
                run = run with { CancelRequested = true };
                using var db = Open(); using var cmd = db.CreateCommand(); cmd.CommandText = "UPDATE runs SET payload=$payload WHERE id=$id";
                cmd.Parameters.AddWithValue("$id", id); cmd.Parameters.AddWithValue("$payload", JsonSerializer.Serialize(run, AppJson.Options)); cmd.ExecuteNonQuery();
            }
            return run;
        }
    }
    private static void Audit(SqliteConnection db, SqliteTransaction transaction, UatRun run, string action, string current, string? feedback = null)
    {
        using var cmd = db.CreateCommand(); cmd.Transaction = transaction;
        cmd.CommandText = "INSERT INTO review_events(run_id,created_at,action,previous,current,feedback_id) VALUES($run,$at,$action,$before,$after,$feedback)";
        cmd.Parameters.AddWithValue("$run", run.Id); cmd.Parameters.AddWithValue("$at", DateTimeOffset.UtcNow.ToString("O"));
        cmd.Parameters.AddWithValue("$action", action); cmd.Parameters.AddWithValue("$before", run.Acceptance); cmd.Parameters.AddWithValue("$after", current);
        cmd.Parameters.AddWithValue("$feedback", (object?)feedback ?? DBNull.Value); cmd.ExecuteNonQuery();
    }
    public List<ReviewEvent> ReviewHistory(string id, long after = 0)
    {
        lock (gate)
        {
            _ = Get(id); using var db = Open(); using var cmd = db.CreateCommand();
            cmd.CommandText = "SELECT sequence,created_at,action,previous,current,feedback_id FROM review_events WHERE run_id=$id AND sequence>$after ORDER BY sequence LIMIT 50";
            cmd.Parameters.AddWithValue("$id", id); cmd.Parameters.AddWithValue("$after", after);
            using var reader = cmd.ExecuteReader(); var result = new List<ReviewEvent>();
            while (reader.Read()) result.Add(new(reader.GetInt64(0), DateTimeOffset.Parse(reader.GetString(1)), reader.GetString(2), reader.GetString(3), reader.GetString(4), reader.IsDBNull(5) ? null : reader.GetString(5)));
            return result;
        }
    }
    private PageResult<T> ReadPage<T>(string table, int page, int size, string? test, string? application, string? status, string? acceptance, long? snapshot = null)
    {
        if (page < 1 || page > 1000000 || size is < 1 or > 100) throw new ArgumentException("Use page >= 1 and page size between 1 and 100.");
        using var db = Open(); using var cmd = db.CreateCommand();
        if (snapshot < 0) throw new ArgumentException("Invalid history snapshot.");
        cmd.CommandText = $"SELECT COALESCE(MAX(rowid),0) FROM {table}";
        var boundary = snapshot ?? Convert.ToInt64(cmd.ExecuteScalar());
        cmd.Parameters.AddWithValue("$snapshot", boundary);
        var where = "WHERE rowid <= $snapshot AND ($test IS NULL OR json_extract(payload,'$.testId')=$test) AND ($app IS NULL OR json_extract(payload,'$.applicationId')=$app) AND ($status IS NULL OR json_extract(payload,'$.status')=$status) AND ($acceptance IS NULL OR json_extract(payload,'$.acceptance')=$acceptance)";
        cmd.Parameters.AddWithValue("$test", (object?)test ?? DBNull.Value); cmd.Parameters.AddWithValue("$app", (object?)application ?? DBNull.Value);
        cmd.Parameters.AddWithValue("$status", (object?)status ?? DBNull.Value); cmd.Parameters.AddWithValue("$acceptance", (object?)acceptance ?? DBNull.Value);
        // Table names are fixed by the methods below, never accepted from HTTP.
        cmd.CommandText = $"SELECT COUNT(*) FROM {table} {where}"; var total = Convert.ToInt32(cmd.ExecuteScalar());
        cmd.CommandText = $"SELECT payload FROM {table} {where} ORDER BY rowid DESC LIMIT $size OFFSET $offset";
        cmd.Parameters.AddWithValue("$size", size); cmd.Parameters.AddWithValue("$offset", (long)(page - 1) * size);
        using var reader = cmd.ExecuteReader(); var items = new List<T>();
        while (reader.Read()) items.Add(JsonSerializer.Deserialize<T>(reader.GetString(0), AppJson.Options)!);
        return new(items, total, page, size, boundary);
    }
    public PageResult<UatRun> History(int page = 1, int size = 20, string? test = null, string? application = null, string? status = null, string? acceptance = null, long? snapshot = null)
    { lock (gate) { Sweep(); return ReadPage<UatRun>("runs", page, size, test, application, status, acceptance, snapshot); } }
    public PageResult<ImprovementJob> JobHistory(int page = 1, int size = 20, string? application = null, string? status = null, long? snapshot = null)
    { lock (gate) { Sweep(); return ReadPage<ImprovementJob>("improvement_jobs", page, size, null, application, status, null, snapshot); } }
    public List<ImprovementJob> JobsForRun(string id)
    {
        lock (gate)
        {
            using var db = Open(); using var cmd = db.CreateCommand(); cmd.CommandText = "SELECT payload FROM improvement_jobs WHERE run_id=$id ORDER BY rowid DESC LIMIT 100"; cmd.Parameters.AddWithValue("$id", id);
            using var reader = cmd.ExecuteReader(); var result = new List<ImprovementJob>(); while (reader.Read()) result.Add(JsonSerializer.Deserialize<ImprovementJob>(reader.GetString(0), AppJson.Options)!); return result;
        }
    }
    private List<CleanupTask> ReadCleanups(string suffix = "ORDER BY rowid DESC LIMIT 100")
    {
        using var db = Open(); using var cmd = db.CreateCommand(); cmd.CommandText = "SELECT payload FROM cleanup_tasks " + suffix;
        using var reader = cmd.ExecuteReader(); var result = new List<CleanupTask>(); while (reader.Read()) result.Add(JsonSerializer.Deserialize<CleanupTask>(reader.GetString(0), AppJson.Options)!); return result;
    }
    private CleanupTask ReadCleanup(string id)
    {
        using var db = Open(); using var cmd = db.CreateCommand(); cmd.CommandText = "SELECT payload FROM cleanup_tasks WHERE id=$id"; cmd.Parameters.AddWithValue("$id", id);
        return cmd.ExecuteScalar() is string value ? JsonSerializer.Deserialize<CleanupTask>(value, AppJson.Options)! : throw new ArgumentException("Unknown cleanup task.");
    }
    private void SaveCleanup(CleanupTask task, string? lease = null, DateTimeOffset? expires = null)
    {
        using var db = Open(); using var cmd = db.CreateCommand(); cmd.CommandText = "INSERT INTO cleanup_tasks(id,payload,lease,lease_expires) VALUES($id,$payload,$lease,$expires) ON CONFLICT(id) DO UPDATE SET payload=$payload,lease=$lease,lease_expires=$expires";
        cmd.Parameters.AddWithValue("$id", task.Id); cmd.Parameters.AddWithValue("$payload", JsonSerializer.Serialize(task, AppJson.Options));
        cmd.Parameters.AddWithValue("$lease", (object?)lease ?? DBNull.Value); cmd.Parameters.AddWithValue("$expires", (object?)expires?.ToString("O") ?? DBNull.Value); cmd.ExecuteNonQuery();
    }
    private void RecoverCleanups()
    {
        foreach (var task in ReadCleanups("WHERE json_extract(payload,'$.status')='running'"))
            SaveCleanup(task with { Status = "interrupted", UpdatedAt = DateTimeOffset.UtcNow, Error = "Dashboard restarted. Preview again to retry cleanup." });
    }
    private void ExpireCleanups()
    {
        foreach (var task in ReadCleanups($"WHERE lease_expires IS NOT NULL AND lease_expires < '{DateTimeOffset.UtcNow:O}'"))
            SaveCleanup(task with { Status = "interrupted", UpdatedAt = DateTimeOffset.UtcNow, Error = "Cleanup worker heartbeat expired. Preview again to retry." });
    }
    public List<CleanupTask> Cleanups() { lock (gate) { ExpireCleanups(); return ReadCleanups(); } }
    public PageResult<CleanupTask> CleanupHistory(int page = 1, long? snapshot = null)
    { lock (gate) { ExpireCleanups(); return ReadPage<CleanupTask>("cleanup_tasks", page, 20, null, null, null, null, snapshot); } }
    public CleanupTask CancelCleanup(string id)
    {
        lock (gate)
        {
            var task = ReadCleanup(id);
            if (task.Status == "cancelled") return task;
            if (task.Status != "queued") throw new ArgumentException("This removal has already started or finished. Inspect its journal before retrying.");
            task = task with { Status = "cancelled", UpdatedAt = DateTimeOffset.UtcNow, Error = "Cancelled before removal." };
            SaveCleanup(task); return task;
        }
    }
    private bool CleanupActive(string kind, string id) => ReadCleanups("WHERE json_extract(payload,'$.status') IN ('queued','running')")
        .Any(t => t.Kind == kind && t.ResourceId == id);
    private void EnsureNoEvidenceCleanup(string id)
    { if (CleanupActive("evidence", id)) throw new ArgumentException("Evidence cleanup is in progress. Wait for it to finish."); }
    private static string Token(string value) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value)));
    private CleanupCandidate? EvidenceCandidate(UatRun run, int days)
    {
        if (run.CompletedAt is null || run.CompletedAt > DateTimeOffset.UtcNow.AddDays(-days) || run.Acceptance != "accepted" || CleanupActive("evidence", run.Id)) return null;
        if (JobsForRun(run.Id).Any(j => j.Status is "draft" or "queued" || JobStates.Active(j.Status))) return null;
        var folder = Path.Combine(DataPath, "evidence", run.Id);
        if (run.Trace is null && !run.Steps.Any(s => s.Screenshot is not null) && !Directory.Exists(folder)) return null;
        long? bytes;
        try { bytes = Directory.Exists(folder) ? new DirectoryInfo(folder).EnumerateFiles().Sum(f => f.Length) : 0; }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException) { bytes = null; }
        if (run.EvidenceRetiredAt is not null && bytes == 0 && ReadCleanups("WHERE json_extract(payload,'$.status')='completed'").Any(t => t.Kind == "evidence" && t.ResourceId == run.Id)) return null;
        return new("evidence", run.Id, $"{run.TestSnapshot.Title} · {run.Id[..8]} · {run.CompletedAt:g}", Token(JsonSerializer.Serialize(run, AppJson.Options)), bytes);
    }
    private CleanupCandidate? WorktreeCandidate(ImprovementJob job)
    {
        if (job.WorktreePath is null || job.WorktreeRemovedAt is not null || CleanupActive("worktree", job.Id) || JobStates.Active(job.Status) || job.Status is "queued" or "draft") return null;
        if (job.UpdatedAt > DateTimeOffset.UtcNow.AddMinutes(-2)) return null;
        if (job.Status == "awaiting-review" && (job.RerunId is null || Get(job.RerunId).Acceptance != "accepted")) return null;
        return new("worktree", job.Id, $"{job.ApplicationId} · job {job.Id[..8]} · {job.WorktreePath}", Token(JsonSerializer.Serialize(job, AppJson.Options)));
    }
    public List<CleanupCandidate> CleanupPreview(int days = 30) => PreviewCleanupBatch(days).Items;
    public CleanupBatch PreviewCleanupBatch(int days = 30, int page = 1)
    {
        lock (gate)
        {
            if (days is < 1 or > 3650) throw new ArgumentException("Retention must be between 1 and 3650 days.");
            if (page is < 1 or > 1000000) throw new ArgumentException("Invalid preview page.");
            Sweep(); var result = new List<CleanupCandidate>();
            var offset = (long)(page - 1) * 200;
            var runs = ReadRuns("WHERE json_extract(payload,'$.acceptance')='accepted' AND (json_extract(payload,'$.evidenceRetiredAt') IS NULL OR NOT EXISTS (SELECT 1 FROM cleanup_tasks c WHERE json_extract(c.payload,'$.resourceId')=runs.id AND json_extract(c.payload,'$.kind')='evidence' AND json_extract(c.payload,'$.status')='completed')) ORDER BY rowid LIMIT 201 OFFSET " + offset);
            var jobs = ReadJobs("WHERE json_extract(payload,'$.worktreePath') IS NOT NULL AND json_extract(payload,'$.worktreeRemovedAt') IS NULL ORDER BY rowid LIMIT 201 OFFSET " + offset);
            foreach (var run in runs.Take(200))
                if (EvidenceCandidate(run, days) is { } evidence) result.Add(evidence);
            foreach (var job in jobs.Take(200))
                if (WorktreeCandidate(job) is { } tree) result.Add(tree);
            return new(result, page, runs.Count > 200 || jobs.Count > 200);
        }
    }
    public CleanupTask RequestCleanup(CleanupRequest request)
    {
        lock (gate)
        {
            if (request.RetentionDays is < 1 or > 3650) throw new ArgumentException("Invalid retention period.");
            Sweep();
            var candidate = request.Kind switch { "evidence" => EvidenceCandidate(Get(request.ResourceId), request.RetentionDays), "worktree" => WorktreeCandidate(Job(request.ResourceId)), _ => null };
            if (candidate is null || candidate.Token != request.Token) throw new ArgumentException("This cleanup preview is stale or the resource is protected. Preview again.");
            var now = DateTimeOffset.UtcNow;
            var job = request.Kind == "worktree" ? Job(request.ResourceId) : null;
            var task = new CleanupTask(Guid.NewGuid().ToString("N"), request.Kind, request.ResourceId, "queued", now, now,
                job?.ApplicationId ?? Get(request.ResourceId).ApplicationId, job?.WorktreePath, job?.ResultCommit ?? job?.BaseCommit, Recipe: job?.Recipe);
            SaveCleanup(task); return task;
        }
    }
    public CleanupClaim? ClaimCleanup()
    {
        lock (gate)
        {
            Sweep(); var task = ReadCleanups("WHERE json_extract(payload,'$.status')='queued' ORDER BY rowid LIMIT 1").FirstOrDefault();
            if (task is null) return null;
            if (task.Kind == "worktree" && ReadJob(task.ResourceId) is { Status: "awaiting-review", RerunId: {} rerunId } && Get(rerunId).Acceptance != "accepted")
            { SaveCleanup(task with { Status = "failed", UpdatedAt = DateTimeOffset.UtcNow, Error = "The new run no longer has human acceptance. Preview again after review." }); return null; }
            var lease = Guid.NewGuid().ToString("N"); task = task with { Status = "running", UpdatedAt = DateTimeOffset.UtcNow };
            if (task.Kind == "evidence")
            {
                var run = Get(task.ResourceId);
                // Retire access before file removal. A crash can leave bytes for a
                // later explicit retry, never silently restore removed evidence.
                Save(run with { EvidenceRetiredAt = run.EvidenceRetiredAt ?? DateTimeOffset.UtcNow });
            }
            SaveCleanup(task, lease, DateTimeOffset.UtcNow.AddSeconds(45)); return new(task, lease);
        }
    }
    private CleanupTask RequireCleanupLease(string id, string lease)
    {
        ExpireCleanups(); var task = ReadCleanup(id); using var db = Open(); using var cmd = db.CreateCommand();
        cmd.CommandText = "SELECT lease FROM cleanup_tasks WHERE id=$id"; cmd.Parameters.AddWithValue("$id", id);
        if (task.Status != "running" || string.IsNullOrWhiteSpace(lease) || cmd.ExecuteScalar() as string != lease) throw new ArgumentException("The cleanup lease is no longer valid.");
        return task;
    }
    public CleanupTask HeartbeatCleanup(string id, string lease)
    { lock (gate) { var task = RequireCleanupLease(id, lease); SaveCleanup(task, lease, DateTimeOffset.UtcNow.AddSeconds(45)); return task; } }
    public CleanupTask FinishCleanup(string id, CleanupFinish request)
    {
        lock (gate)
        {
            var task = RequireCleanupLease(id, request.Lease);
            if (request.Status is not ("completed" or "failed" or "interrupted") || request.Error?.Length > 8000) throw new ArgumentException("Invalid cleanup result.");
            task = task with { Status = request.Status, UpdatedAt = DateTimeOffset.UtcNow, Error = request.Error };
            if (request.Status == "completed" && task.Kind == "worktree")
            {
                var job = ReadJob(task.ResourceId) with { WorktreeRemovedAt = DateTimeOffset.UtcNow };
                using var db = Open(); using var transaction = db.BeginTransaction(); using var cmd = db.CreateCommand(); cmd.Transaction = transaction;
                cmd.CommandText = "UPDATE improvement_jobs SET payload=$job WHERE id=$jobId; UPDATE cleanup_tasks SET payload=$task,lease=NULL,lease_expires=NULL WHERE id=$id";
                cmd.Parameters.AddWithValue("$job", JsonSerializer.Serialize(job, AppJson.Options)); cmd.Parameters.AddWithValue("$jobId", job.Id);
                cmd.Parameters.AddWithValue("$task", JsonSerializer.Serialize(task, AppJson.Options)); cmd.Parameters.AddWithValue("$id", id); cmd.ExecuteNonQuery(); transaction.Commit();
                Event(job, "Reviewed worktree removed. The result commit and branch are retained.");
            }
            else SaveCleanup(task);
            return task;
        }
    }
}

public sealed class LeaseMonitor(RunStore store, ILogger<LeaseMonitor> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(5));
        try { while (await timer.WaitForNextTickAsync(stoppingToken)) { try { store.Sweep(); } catch (Exception error) { logger.LogError(error, "Worker lease recovery failed."); } } }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { }
    }
}
