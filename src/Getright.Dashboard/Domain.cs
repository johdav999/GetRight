using System.Reflection;
using System.Text.Json;

namespace Getright.Dashboard;

public record UatApplication(string Id, string Name, string Description, string RepositoryHint);
public record TestStep(string Id, string Title, string Expected);
public record UatTest(string Id, string ApplicationId, string Title, string Purpose,
    string Readiness, string? Adapter, string ReviewQuestion, List<TestStep> Steps,
    string? Preconditions = null, string? GenerationId = null, WorkflowImplementation? Implementation = null);
public record Catalogue(List<UatApplication> Applications, List<UatTest> Tests);
public record StepResult(string StepId, string Status, string? Screenshot, string? Error);
public record UatRun(string Id, string TestId, string ApplicationId, string Status,
    string Acceptance, DateTimeOffset CreatedAt, DateTimeOffset? StartedAt,
    DateTimeOffset? CompletedAt, string FixtureId, string? BuildVersion,
    string? BaseUrl, List<StepResult> Steps, string? Trace, string? Error,
    UatTest TestSnapshot, ApplicationProfile? Target = null, ExecutionIdentity? Identity = null,
    string? ImprovementJobId = null, string? ParentRunId = null, bool CancelRequested = false, DateTimeOffset? EvidenceRetiredAt = null,
    string? CaseImplementationJobId = null, bool Docked = false, bool StepByStep = false, List<string>? AssistedSteps = null);
public record ApplicationProfile(string ApplicationId, string BaseUrl, string ExpectedBuildVersion,
    string ExpectedUserId, bool IsolatedDataConfirmed, string? SourceCommit = null, bool SourceWasDirty = false,
    string? ExpectedCompanyId = null, string? ExpectedRole = null);
public record ExecutionIdentity(string UserId, string? DocumentId, string EvidenceKind, List<string>? Roles = null,
    string? CompanyId = null, string? IsolationCompanyId = null);
public record ApplicationReadiness(bool Ready, string Message, string? RunningVersion = null);
public record Feedback(string Id, string RunId, string StepId, string Comment,
    string RequestedOutcome, DateTimeOffset CreatedAt, string Prompt);
public record FeedbackRequest(string StepId, string Comment, string RequestedOutcome);
public record ReviewRequest(string Acceptance);
public record QueueRequest(string TestId, bool Docked = false, bool StepByStep = false);
public record CompletionRequest(string Lease, string Status, string? BuildVersion,
    string? BaseUrl, List<StepResult>? Steps, string? Trace, string? Error, ExecutionIdentity? Identity = null);
public record RunLease(UatRun Run, string Lease);

public static class AppJson
{
    public static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web);
    public static readonly string BuildVersion = typeof(AppJson).Assembly
        .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion ?? "unknown";
}

public sealed class UatCatalogue
{
    public Catalogue Value { get; }
    public UatCatalogue()
    {
        var path = Path.Combine(AppContext.BaseDirectory, "catalog.json");
        Value = JsonSerializer.Deserialize<Catalogue>(File.ReadAllText(path), AppJson.Options)
            ?? throw new InvalidOperationException("The catalogue is empty.");
        if (Value.Tests.Select(t => t.Id).Distinct().Count() != Value.Tests.Count ||
            Value.Tests.Any(t => t.Steps.Count == 0 ||
                t.Steps.Select(s => s.Id).Distinct().Count() != t.Steps.Count ||
                !Value.Applications.Any(a => a.Id == t.ApplicationId)))
            throw new InvalidOperationException("The catalogue contains duplicate IDs or invalid test definitions.");
    }
    public UatTest Get(string id) => Value.Tests.FirstOrDefault(t => t.Id == id)
        ?? throw new ArgumentException("Unknown test.");
}
