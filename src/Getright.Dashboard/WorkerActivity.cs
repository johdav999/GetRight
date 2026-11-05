using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Getright.Dashboard;

public record WorkerRegistration(string Id, int ProcessId);
public record WorkerPulse(string Token, string Kind, List<string> WorkIds, List<string> ReviewRunIds);
public record WorkerView(string Id, int ProcessId, string Kind, bool Connected, DateTimeOffset LastSeen, List<string> WorkIds, List<string> ReviewRunIds);
public record WorkView(string Id, string Kind, string Title, string Stage, string Url, bool Paused = false);
public record WorkerQueue(int Runs, int Cases, int Improvements, int Cleanup);
public record WorkerOverview(List<WorkerView> Workers, List<WorkView> Active, List<WorkView> Reviews, WorkerQueue Queued);

public sealed partial class RunStore
{
    public (WorkerQueue Queued, List<WorkView> Active) WorkerWork()
    {
        lock (gate)
        {
            Sweep(); using var db = Open(); using var cmd = db.CreateCommand();
            cmd.CommandText = """
                SELECT (SELECT COUNT(*) FROM runs WHERE json_extract(payload,'$.status')='queued'),
                  (SELECT COUNT(*) FROM case_implementation_jobs WHERE json_extract(payload,'$.status')='queued'),
                  (SELECT COUNT(*) FROM improvement_jobs WHERE json_extract(payload,'$.status')='queued'),
                  (SELECT COUNT(*) FROM cleanup_tasks WHERE json_extract(payload,'$.status')='queued')
                """;
            WorkerQueue queue;
            using (var reader = cmd.ExecuteReader()) { reader.Read(); queue = new(reader.GetInt32(0), reader.GetInt32(1), reader.GetInt32(2), reader.GetInt32(3)); }
            cmd.CommandText = """
                SELECT 'run',payload FROM runs WHERE json_extract(payload,'$.status')='running'
                UNION ALL SELECT 'case',payload FROM case_implementation_jobs WHERE json_extract(payload,'$.status') IN ('preparing','planning','building','implementing','validating')
                UNION ALL SELECT 'improvement',payload FROM improvement_jobs WHERE json_extract(payload,'$.status') IN ('preparing','implementing','building','launching','rerunning')
                UNION ALL SELECT 'cleanup',payload FROM cleanup_tasks WHERE json_extract(payload,'$.status')='running'
                LIMIT 64
                """;
            var active = new List<WorkView>(); using var rows = cmd.ExecuteReader();
            while (rows.Read())
            {
                var kind = rows.GetString(0); using var json = JsonDocument.Parse(rows.GetString(1)); var value = json.RootElement;
                var id = value.GetProperty("id").GetString()!;
                var title = value.TryGetProperty("testSnapshot", out var test) ? test.GetProperty("title").GetString()! :
                    kind == "improvement" ? $"Improving {value.GetProperty("applicationId").GetString()}" : "Local storage cleanup";
                active.Add(new(id, kind, title, value.GetProperty("status").GetString()!, kind switch {
                    "run" => $"/runs/{id}", "case" => $"/case-implementations/{id}", "improvement" => $"/jobs/{id}", _ => "/maintenance" }));
            }
            return (queue, active);
        }
    }
}

// Local-only telemetry. Private renewal tokens never appear in public status or
// storage. Run/job leases, step progress and stored results remain authoritative.
public sealed class WorkerActivity(RunStore store, LiveBrowser browser)
{
    private sealed record Entry(string Token, WorkerView View);
    private readonly object gate = new();
    private readonly Dictionary<string, Entry> workers = [];
    private static bool Id(string? id) => id is not null && Regex.IsMatch(id, "^[a-f0-9]{32}$");
    public object Connect(WorkerRegistration request)
    {
        if (!Id(request.Id) || request.ProcessId <= 0) throw new ArgumentException("Invalid worker identity.");
        lock (gate)
        {
            foreach (var id in workers.Where(p => DateTimeOffset.UtcNow - p.Value.View.LastSeen > TimeSpan.FromMinutes(1)).Select(p => p.Key).ToArray()) workers.Remove(id);
            if (!workers.ContainsKey(request.Id) && workers.Count >= 16) throw new ArgumentException("Too many registered workers.");
            var token = Guid.NewGuid().ToString("N");
            workers[request.Id] = new(token, new(request.Id, request.ProcessId, "idle", true, DateTimeOffset.UtcNow, [], []));
            return new { token };
        }
    }
    public void Pulse(string id, WorkerPulse request)
    {
        if (request.Kind is not ("idle" or "run" or "case-implementation" or "improvement" or "cleanup" or "stopped") ||
            request.WorkIds is null || request.WorkIds.Count > 10 || request.WorkIds.Any(i => !Id(i)) ||
            request.ReviewRunIds is null || request.ReviewRunIds.Count > 4 || request.ReviewRunIds.Any(i => !Id(i))) throw new ArgumentException("Invalid worker activity.");
        lock (gate)
        {
            if (!workers.TryGetValue(id, out var worker) || request.Token is null || request.Token.Length != 32 ||
                !CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(request.Token), Encoding.UTF8.GetBytes(worker.Token))) throw new ArgumentException("Worker status ownership expired.");
            workers[id] = worker with { View = worker.View with { Kind = request.Kind, LastSeen = DateTimeOffset.UtcNow,
                WorkIds = [.. request.WorkIds], ReviewRunIds = [.. request.ReviewRunIds] } };
        }
    }
    public WorkerOverview Snapshot()
    {
        List<WorkerView> views;
        lock (gate) views = workers.Values.Select(e => e.View with { Connected = e.View.Kind != "stopped" && DateTimeOffset.UtcNow - e.View.LastSeen < TimeSpan.FromSeconds(15) }).ToList();
        var (queued, active) = store.WorkerWork();
        active = active.Select(item => item.Kind == "run" && browser.StepProgress(item.Id) is { Stage: "waiting" } progress
            ? item with { Paused = true, Stage = $"Paused before step {progress.StepIndex + 1}" } : item).ToList();
        var reviews = browser.ReviewRunIds().Select(id => { var run = store.Get(id); return new WorkView(id, "review", run.TestSnapshot.Title, run.Status, $"/runs/{id}/live"); }).ToList();
        return new(views, active, reviews, queued);
    }
}
