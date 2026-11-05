using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace Getright.Dashboard;

public record TestSuite(string Id, string ApplicationId, string Name, string Description,
    List<string> TestIds, int Revision, DateTimeOffset CreatedAt);
public record CreateSuiteRequest(string ApplicationId, string Name, string Description, List<string>? TestIds);
public record EditSuiteRequest(int Revision, string Name, string Description, List<string>? TestIds);
public record GenerateCasesRequest(string Feature, int Count);
public record ApplyCasesRequest(List<ProposedCase>? Cases);
public record CaseProposal(string Id, string SuiteId, string Feature, string Model, string ResponseId,
    DateTimeOffset CreatedAt, List<ProposedCase> Cases, DateTimeOffset? AppliedAt = null, List<string>? TestIds = null);
public sealed class ProposedCase
{
    public string Title { get; set; } = "";
    public string Purpose { get; set; } = "";
    public string Preconditions { get; set; } = "";
    public string ReviewQuestion { get; set; } = "";
    public List<ProposedStep> Steps { get; set; } = [];
}
public sealed class ProposedStep
{
    public string Action { get; set; } = "";
    public string Expected { get; set; } = "";
}

public sealed partial class RunStore
{
    private void SeedSuites(SqliteConnection db, SqliteTransaction transaction)
    {
        foreach (var application in catalogue.Value.Applications)
        {
            var suite = new TestSuite($"{application.Id}-suite", application.Id, $"{application.Name} UAT",
                application.Description, catalogue.Value.Tests.Where(t => t.ApplicationId == application.Id).Select(t => t.Id).ToList(), 1, DateTimeOffset.UtcNow);
            WriteSuite(db, transaction, suite);
        }
    }
    private static void WriteSuite(SqliteConnection db, SqliteTransaction transaction, TestSuite suite)
    {
        using var cmd = db.CreateCommand(); cmd.Transaction = transaction;
        cmd.CommandText = "INSERT INTO test_suites(id,payload) VALUES($id,$payload) ON CONFLICT(id) DO UPDATE SET payload=$payload";
        cmd.Parameters.AddWithValue("$id", suite.Id); cmd.Parameters.AddWithValue("$payload", JsonSerializer.Serialize(suite, AppJson.Options)); cmd.ExecuteNonQuery();
    }
    public List<TestSuite> Suites()
    {
        lock (gate)
        {
            using var db = Open(); using var cmd = db.CreateCommand(); cmd.CommandText = "SELECT payload FROM test_suites ORDER BY rowid";
            using var reader = cmd.ExecuteReader(); var result = new List<TestSuite>();
            while (reader.Read()) result.Add(JsonSerializer.Deserialize<TestSuite>(reader.GetString(0), AppJson.Options)!);
            return result;
        }
    }
    public TestSuite Suite(string id)
    {
        lock (gate)
        {
            using var db = Open(); using var cmd = db.CreateCommand(); cmd.CommandText = "SELECT payload FROM test_suites WHERE id=$id";
            cmd.Parameters.AddWithValue("$id", id);
            return cmd.ExecuteScalar() is string payload ? JsonSerializer.Deserialize<TestSuite>(payload, AppJson.Options)! : throw new ArgumentException("Unknown test suite.");
        }
    }
    public List<UatTest> Tests()
    {
        lock (gate)
        {
            var result = new List<UatTest>(catalogue.Value.Tests);
            using var db = Open(); using var cmd = db.CreateCommand(); cmd.CommandText = "SELECT payload FROM draft_test_cases ORDER BY rowid";
            using var reader = cmd.ExecuteReader();
            while (reader.Read()) result.Add(JsonSerializer.Deserialize<UatTest>(reader.GetString(0), AppJson.Options)!);
            reader.Close();
            cmd.CommandText = "SELECT test_id,payload FROM case_bindings";
            var currentEngine = WorkflowContract.LocalEngineDigest();
            using var bindings = cmd.ExecuteReader();
            while (bindings.Read())
            {
                var index = result.FindIndex(t => t.Id == bindings.GetString(0));
                if (index < 0) continue;
                var binding = JsonSerializer.Deserialize<WorkflowImplementation>(bindings.GetString(1), AppJson.Options)!;
                if (DefinitionDigest(result[index]) == binding.DefinitionDigest)
                    result[index] = result[index] with { Readiness = currentEngine == binding.EngineDigest ? "ready" : "reverification-required", Adapter = "declarative-v1", Implementation = binding };
            }
            return result;
        }
    }
    public UatTest Test(string id) => Tests().FirstOrDefault(t => t.Id == id) ?? throw new ArgumentException("Unknown test case.");
    private List<string> ValidateSuite(string applicationId, string name, string description, List<string>? testIds)
    {
        if (!catalogue.Value.Applications.Any(a => a.Id == applicationId)) throw new ArgumentException("Choose a known application.");
        RequireText(name, "Suite name", 120); RequireText(description, "Suite description", 4000);
        var ids = testIds ?? [];
        if (ids.Count > 250 || ids.Distinct().Count() != ids.Count) throw new ArgumentException("A suite supports up to 250 distinct test cases.");
        var available = Tests().Where(t => t.ApplicationId == applicationId).Select(t => t.Id).ToHashSet();
        if (ids.Any(id => !available.Contains(id))) throw new ArgumentException("Every test case must belong to this suite's application.");
        return ids;
    }
    public TestSuite CreateSuite(CreateSuiteRequest request)
    {
        lock (gate)
        {
            var ids = ValidateSuite(request.ApplicationId, request.Name, request.Description, request.TestIds);
            var suite = new TestSuite(Guid.NewGuid().ToString("N"), request.ApplicationId, request.Name.Trim(), request.Description.Trim(), ids, 1, DateTimeOffset.UtcNow);
            using var db = Open(); using var transaction = db.BeginTransaction(); WriteSuite(db, transaction, suite); transaction.Commit(); return suite;
        }
    }
    public TestSuite EditSuite(string id, EditSuiteRequest request)
    {
        lock (gate)
        {
            var previous = Suite(id);
            if (previous.Revision != request.Revision) throw new ArgumentException("This suite changed. Reload it before saving your edits.");
            var ids = ValidateSuite(previous.ApplicationId, request.Name, request.Description, request.TestIds);
            var suite = previous with { Name = request.Name.Trim(), Description = request.Description.Trim(), TestIds = ids, Revision = previous.Revision + 1 };
            using var db = Open(); using var transaction = db.BeginTransaction(); WriteSuite(db, transaction, suite); transaction.Commit(); return suite;
        }
    }
    public static void RequireText(string? text, string label, int maximum)
    {
        if (string.IsNullOrWhiteSpace(text) || text.Length > maximum) throw new ArgumentException($"{label} is required and must be at most {maximum} characters.");
    }
    public static void ValidateCases(List<ProposedCase>? cases, int? expectedCount = null)
    {
        if (cases is null || cases.Count < 1 || cases.Count > 10 || (expectedCount is not null && cases.Count != expectedCount))
            throw new ArgumentException("Provide the requested number of test cases (1–10).");
        if (cases.Select(c => c?.Title?.Trim()).Distinct(StringComparer.OrdinalIgnoreCase).Count() != cases.Count) throw new ArgumentException("Test case titles must be distinct.");
        foreach (var test in cases)
        {
            if (test is null) throw new ArgumentException("A test case cannot be empty.");
            RequireText(test.Title, "Test title", 180); RequireText(test.Purpose, "Purpose", 2000);
            RequireText(test.Preconditions, "Preconditions", 3000); RequireText(test.ReviewQuestion, "Review question", 1000);
            if (test.Steps is null || test.Steps.Count is < 1 or > 10) throw new ArgumentException("Each test case needs 1–10 steps.");
            foreach (var step in test.Steps)
            {
                if (step is null) throw new ArgumentException("A test step cannot be empty.");
                RequireText(step.Action, "Step action", 1000); RequireText(step.Expected, "Expected result", 1500);
            }
        }
    }
    public CaseProposal SaveProposal(string suiteId, string feature, string model, string responseId, List<ProposedCase> cases, int count)
    {
        lock (gate)
        {
            _ = Suite(suiteId); ValidateCases(cases, count);
            var proposal = new CaseProposal(Guid.NewGuid().ToString("N"), suiteId, feature.Trim(), model, responseId, DateTimeOffset.UtcNow, cases);
            using var db = Open(); using var cmd = db.CreateCommand();
            cmd.CommandText = "INSERT INTO case_proposals(id,suite_id,payload) VALUES($id,$suite,$payload)";
            cmd.Parameters.AddWithValue("$id", proposal.Id); cmd.Parameters.AddWithValue("$suite", suiteId); cmd.Parameters.AddWithValue("$payload", JsonSerializer.Serialize(proposal, AppJson.Options)); cmd.ExecuteNonQuery(); return proposal;
        }
    }
    public List<CaseProposal> Proposals(string suiteId)
    {
        lock (gate)
        {
            _ = Suite(suiteId); using var db = Open(); using var cmd = db.CreateCommand();
            cmd.CommandText = "SELECT payload FROM case_proposals WHERE suite_id=$suite ORDER BY rowid DESC LIMIT 20"; cmd.Parameters.AddWithValue("$suite", suiteId);
            using var reader = cmd.ExecuteReader(); var result = new List<CaseProposal>();
            while (reader.Read()) result.Add(JsonSerializer.Deserialize<CaseProposal>(reader.GetString(0), AppJson.Options)!);
            return result;
        }
    }
    public TestSuite ApplyProposal(string suiteId, string proposalId, ApplyCasesRequest request)
    {
        lock (gate)
        {
            var suite = Suite(suiteId);
            using var db = Open(); using var transaction = db.BeginTransaction();
            using var read = db.CreateCommand(); read.Transaction = transaction;
            read.CommandText = "SELECT payload FROM case_proposals WHERE id=$id AND suite_id=$suite";
            read.Parameters.AddWithValue("$id", proposalId); read.Parameters.AddWithValue("$suite", suiteId);
            var proposal = read.ExecuteScalar() is string payload ? JsonSerializer.Deserialize<CaseProposal>(payload, AppJson.Options)! : throw new ArgumentException("Unknown proposal for this suite.");
            if (proposal.AppliedAt is not null) return suite; // Safe replay after a lost acknowledgement.
            ValidateCases(request.Cases);
            if (suite.TestIds.Count + request.Cases!.Count > 250) throw new ArgumentException("This suite already has too many cases. Create another suite.");
            var ids = new List<string>();
            foreach (var proposed in request.Cases)
            {
                var id = $"draft-{Guid.NewGuid():N}"; ids.Add(id);
                var test = new UatTest(id, suite.ApplicationId, proposed.Title.Trim(), proposed.Purpose.Trim(), "draft", null,
                    proposed.ReviewQuestion.Trim(), proposed.Steps.Select((s, index) => new TestStep($"step-{index + 1}", s.Action.Trim(), s.Expected.Trim())).ToList(), proposed.Preconditions.Trim(), proposal.Id);
                using var insert = db.CreateCommand(); insert.Transaction = transaction;
                insert.CommandText = "INSERT INTO draft_test_cases(id,suite_id,payload) VALUES($id,$suite,$payload)";
                insert.Parameters.AddWithValue("$id", id); insert.Parameters.AddWithValue("$suite", suiteId); insert.Parameters.AddWithValue("$payload", JsonSerializer.Serialize(test, AppJson.Options)); insert.ExecuteNonQuery();
            }
            suite = suite with { TestIds = [.. suite.TestIds, .. ids], Revision = suite.Revision + 1 };
            WriteSuite(db, transaction, suite);
            using var update = db.CreateCommand(); update.Transaction = transaction;
            update.CommandText = "UPDATE case_proposals SET payload=$payload WHERE id=$id"; update.Parameters.AddWithValue("$id", proposalId);
            update.Parameters.AddWithValue("$payload", JsonSerializer.Serialize(proposal with { AppliedAt = DateTimeOffset.UtcNow, TestIds = ids }, AppJson.Options)); update.ExecuteNonQuery();
            transaction.Commit(); return suite;
        }
    }
}
