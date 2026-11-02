using System.Text.Json;

namespace Getright.Dashboard;

// Acquire before constructing RunStore: a duplicate must never perform restart
// recovery on another live dashboard's leases, even on a different port.
public sealed class DashboardInstance : IDisposable
{
    private readonly FileStream ownership;
    public string Id { get; } = Guid.NewGuid().ToString("N");
    public string DataPath { get; }
    public DashboardInstance(IConfiguration configuration)
    {
        DataPath = RunStore.ResolveDataPath(configuration);
        Directory.CreateDirectory(DataPath);
        try { ownership = new FileStream(Path.Combine(DataPath, "dashboard.instance.json"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.Read); }
        catch (IOException error) { throw new InvalidOperationException("This Getright data directory is already in use by another dashboard. Reuse that instance or stop it before starting another.", error); }
        try
        {
            ownership.SetLength(0);
            JsonSerializer.Serialize(ownership, new { instanceId = Id, processId = Environment.ProcessId, dataPath = DataPath, startedAt = DateTimeOffset.UtcNow }, AppJson.Options);
            ownership.Flush(true);
        }
        catch { ownership.Dispose(); throw; }
    }
    public void Dispose() => ownership.Dispose();
}

public sealed partial class RunStore
{
    public object ActiveWork()
    {
        lock (gate)
        {
            Sweep(); using var db = Open(); using var cmd = db.CreateCommand();
            cmd.CommandText = """
                SELECT
                  (SELECT COUNT(*) FROM runs WHERE json_extract(payload,'$.status') IN ('queued','running')),
                  (SELECT COUNT(*) FROM improvement_jobs WHERE json_extract(payload,'$.status') IN ('queued','preparing','implementing','building','launching','rerunning')),
                  (SELECT COUNT(*) FROM cleanup_tasks WHERE json_extract(payload,'$.status') IN ('queued','running')),
                  (SELECT COUNT(*) FROM case_implementation_jobs WHERE json_extract(payload,'$.status') IN ('queued','preparing','building','implementing','validating'))
                """;
            using var reader = cmd.ExecuteReader(); reader.Read();
            return new { runs = reader.GetInt32(0), jobs = reader.GetInt32(1), cleanup = reader.GetInt32(2), caseImplementations = reader.GetInt32(3) };
        }
    }
}
