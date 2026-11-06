using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace Getright.Dashboard;

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public record ConfiguredWorkflow(int Version, string ReviewPath, ConfiguredStep[] Steps);
[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public record ConfiguredStep(string StepId, ConfiguredAction[] Actions);
[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public record ConfiguredAction(string Kind, WorkflowLocator? Locator = null, string? Value = null, string? Path = null,
    WorkflowHttp? Http = null, WorkflowExtension? Extension = null, int TimeoutMs = 5000);
[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public record WorkflowLocator(string? Css = null, string? Role = null, string? Name = null, string? Label = null, string? TestId = null);
[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public record WorkflowHttp(string Path, string Method = "GET", int Status = 200, string? Session = null, int Attempts = 1,
    WorkflowAssertion[]? Assertions = null, WorkflowCapture? Capture = null, Dictionary<string, JsonElement>? Body = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] WorkflowCapture[]? Captures = null);
[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public record WorkflowAssertion(string Field, JsonElement? EqualsValue = null, string? Binding = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? ContainsText = null);
[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public record WorkflowCapture(string Name, string Field, string Type, string? ResourceKind = null);
[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public record WorkflowExtension(string Id, int Version);
public record ApiObservation(string Method, string Path, int Status, string? Session = null);

public static class ConfiguredWorkflows
{
    public const string Adapter = "configured-v2";
    public const int Version = 2;
    private static readonly Regex Variable = new(@"\{\{([a-zA-Z][a-zA-Z0-9-]{0,39})\}\}");
    private static readonly Regex Path = new(@"\A/(?:[a-zA-Z0-9_./-]*)(?:\?[a-zA-Z0-9_.=&-]+)?\z");
    private const string FieldSegment = @"(?:[A-Za-z_][A-Za-z0-9_]{0,39}|[0-9]{1,3})";
    private static readonly Regex Field = new(@"\A" + FieldSegment + @"(?:\." + FieldSegment + @"){0,5}\z");
    private static readonly Regex Name = new(@"\A[a-zA-Z][a-zA-Z0-9-]{0,39}\z");
    private static readonly HashSet<string> Located = ["click", "fill", "check", "uncheck", "select", "expect-visible", "expect-hidden", "expect-text", "expect-value", "expect-checked", "expect-enabled"];
    private static readonly HashSet<string> TextActions = ["fill", "select", "expect-text", "expect-value"];
    private static readonly string[] CompanySteps = ["company-workflow", "company-create", "company-permissions", "company-reopen"];
    private static readonly Dictionary<string, string[]> FinanceSteps = new()
    {
        ["virtual-company-finance-cash-source"] = ["ask-en", "ask-sv", "open-source"],
        ["virtual-company-finance-invoice-ambiguity"] = ["ask-ambiguous", "clarify"],
        ["virtual-company-finance-invoice-isolation"] = ["read-own", "request-foreign", "verify-isolation"],
        ["virtual-company-finance-category-recommendation"] = ["recommend", "verify-unchanged"],
        ["virtual-company-finance-approval-once"] = ["request", "approve", "replay"],
        ["virtual-company-finance-approval-stale"] = ["request", "change-target", "attempt-approval"]
    };

    private static WorkflowCapture[] Captures(WorkflowHttp? http) =>
        http?.Capture is { } single ? [single] : http?.Captures ?? [];

    public static bool LocalPath(string? value) => value is { Length: <= 500 } && Path.IsMatch(value) && !value.StartsWith("//") &&
        !value.Split('?')[0].Split('/').Any(segment => segment is "." or "..");

    private static bool Text(string? value, HashSet<string> known) => value is { Length: <= 4000 } &&
        Variable.Matches(value).All(match => known.Contains(match.Groups[1].Value)) &&
        !Variable.Replace(value, "").Contains("{{") && !Variable.Replace(value, "").Contains("}}");

    private static bool TemplatePath(string? path, HashSet<string> pathValues) => Text(path, pathValues) && LocalPath(Variable.Replace(path!, "value"));

    private static bool ValidLocator(WorkflowLocator? locator)
    {
        if (locator is null || (locator.Name is not null && locator.Role is null)) return false;
        var choices = new[] { locator.Css, locator.Role, locator.Label, locator.TestId };
        return choices.Count(value => value is not null) == 1 && choices.All(value => value is null || value.Length is > 0 and <= 500) &&
            (locator.Name is null || locator.Name.Length is > 0 and <= 150);
    }

    private static bool Scalar(JsonElement? value, HashSet<string> variables) => value is { ValueKind: JsonValueKind.True or JsonValueKind.False } ||
        (value is { ValueKind: JsonValueKind.Number } number && number.TryGetInt32(out _)) ||
        (value is { ValueKind: JsonValueKind.String } text && Text(text.GetString(), variables));

    public static void Validate(UatTest test, ApplicationManifest manifest)
    {
        var dashboard = !ApplicationManifests.NeedsTarget(manifest);
        if (test.Workflow is not { Version: Version } workflow || test.Implementation is not null || (!dashboard && manifest.Runtime is null) ||
            !LocalPath(workflow.ReviewPath) || workflow.Steps is null || workflow.Steps.Length != test.Steps.Count || workflow.Steps.Length is < 1 or > 30)
            throw new ArgumentException($"Test '{test.Id}' needs a version 2 workflow with every catalogue step and an isolated runtime.");
        var variables = new HashSet<string> { "fixtureId", "unique", "email" };
        var pathValues = new HashSet<string> { "fixtureId", "unique" };
        foreach (var fixture in manifest.Runtime?.Fixtures ?? []) { variables.Add($"fixture-{fixture.Kind}"); pathValues.Add($"fixture-{fixture.Kind}"); }
        var resourceKinds = new HashSet<string>();
        var companySteps = new List<string>();
        var finance = manifest.FixtureAdapter == "virtual-company-test-setup" &&
            FinanceSteps.TryGetValue(test.Id, out var financeSteps) && financeSteps.SequenceEqual(test.Steps.Select(s => s.Id));
        var count = 0;
        for (var index = 0; index < workflow.Steps.Length; index++)
        {
            var step = workflow.Steps[index];
            if (step is null || step.StepId != test.Steps[index].Id || !Regex.IsMatch(step.StepId, @"\A[a-z0-9_-]{1,80}\z") ||
                step.Actions is not { Length: >= 1 and <= 30 } ||
                !step.Actions.Any(action => action is not null && (action.Kind?.StartsWith("expect-", StringComparison.Ordinal) == true ||
                    action.Http is not null || CompanySteps.Contains(action.Extension?.Id) || finance && action.Extension?.Id == "finance-agent-step")))
                throw new ArgumentException($"Test '{test.Id}' needs bounded actions and an assertion for every step in order.");
            if (step.Actions.Any(action => action?.Extension?.Id == "finance-agent-step") &&
                (!finance || step.Actions.Length != 1))
                throw new ArgumentException($"Finance test '{test.Id}' needs exactly one registered extension per step.");
            count += step.Actions.Length;
            foreach (var action in step.Actions)
            {
                if (!ValidAction(action, manifest, variables, pathValues, finance))
                    throw new ArgumentException($"Unsupported action, input or variable in test '{test.Id}', step '{step.StepId}'.");
                if (action.Extension is { } extension && CompanySteps.Contains(extension.Id)) companySteps.Add(extension.Id);
                foreach (var capture in Captures(action.Http))
                {
                    if (!variables.Add(capture.Name) || (capture.ResourceKind is { } kind && !resourceKinds.Add(kind)))
                        throw new ArgumentException($"Duplicate capture or resource kind in test '{test.Id}', step '{step.StepId}'.");
                    if (capture.Type != "text") pathValues.Add(capture.Name);
                }
            }
        }
        if (count > 120) throw new ArgumentException("A configured workflow supports at most 120 actions.");
        if (companySteps.Count > 0 && (!companySteps.SequenceEqual(CompanySteps) || resourceKinds.Contains("company")))
            throw new ArgumentException("The company permission extension requires its four ordered phases and supplies the company resource.");
        if (dashboard && workflow.ReviewPath != manifest.EntryPath)
            throw new ArgumentException("A dashboard fixture can only open its registered entry page.");
    }

    private static bool ValidAction(ConfiguredAction? action, ApplicationManifest manifest, HashSet<string> variables, HashSet<string> pathValues, bool finance)
    {
        if (action is not { Kind: not null, TimeoutMs: >= 100 and <= 15000 }) return false;
        if (!ApplicationManifests.NeedsTarget(manifest) && (action.Http is not null || action.Extension is not null ||
            action.Kind is "request" or "extension" || action.Kind == "goto" && action.Path != $"{manifest.EntryPath}?fixture={{{{fixtureId}}}}")) return false;
        if (action.Kind == "extension") return action is { Locator: null, Value: null, Path: null, Http: null, Extension: { Version: 1 } extension } &&
            (manifest.FixtureAdapter == "writerapp-create-save" && extension.Id is "writerapp-onboarding" or "writerapp-library" ||
             manifest.FixtureAdapter == "virtual-company-test-setup" && CompanySteps.Contains(extension.Id) ||
             finance && extension.Id == "finance-agent-step");
        if (action.Extension is not null) return false;
        if (action.Kind == "goto") return action is { Locator: null, Value: null, Http: null } && TemplatePath(action.Path, pathValues);
        if (action.Path is not null) return false;
        if (action.Kind == "reload") return action is { Locator: null, Value: null, Http: null };
        if (action.Kind == "request") return action is { Locator: null, Value: null, Http: not null } && ValidHttp(action.Http, manifest, variables, pathValues, false);
        return Located.Contains(action.Kind) && ValidLocator(action.Locator) &&
            (TextActions.Contains(action.Kind) ? Text(action.Value, variables) : action.Value is null) &&
            (action.Http is null || action.Kind == "click" && ValidHttp(action.Http, manifest, variables, pathValues, true));
    }

    private static bool ValidHttp(WorkflowHttp http, ApplicationManifest manifest, HashSet<string> variables, HashSet<string> pathValues, bool observed)
    {
        if (!TemplatePath(http.Path, pathValues) || http.Status is < 200 or > 599 || http.Attempts is < 1 or > 3) return false;
        if (observed)
        {
            if (http.Method is not ("GET" or "POST" or "PUT" or "PATCH" or "DELETE") || http.Session is not null || http.Attempts != 1 || http.Body is not null) return false;
        }
        else
        {
            if (http.Session is { } session && !manifest.Runtime!.Identities.Any(identity => identity.Name == session)) return false;
            if (http.Method == "GET") { if (http.Body is not null) return false; }
            else if (http.Method != "POST" || http.Attempts != 1 || !(manifest.WorkflowPosts ?? []).Contains(http.Path) ||
                (http.Body is { } body && (body.Count > 12 || !body.All(pair => Name.IsMatch(pair.Key) && Scalar(pair.Value, variables))))) return false;
        }
        if (http.Assertions is { } assertions && (assertions.Length > 8 || assertions.Any(a => !ValidAssertion(a, variables)))) return false;
        return !(http.Capture is not null && http.Captures is not null) && http.Captures is not { Length: 0 or > 4 } &&
            Captures(http).All(capture => capture is not null && Name.IsMatch(capture.Name ?? "") && Field.IsMatch(capture.Field ?? "") &&
                capture.Type is "uuid" or "integer" or "boolean" or "text" &&
                (capture.ResourceKind is null || capture.Type == "uuid" && Name.IsMatch(capture.ResourceKind)));
    }

    private static bool ValidAssertion(WorkflowAssertion? assertion, HashSet<string> variables)
    {
        if (assertion is null) return false;
        if (assertion.ContainsText is { Length: > 0 } text)
            return (assertion.Field == "$" || Field.IsMatch(assertion.Field ?? "")) && assertion.Binding is null &&
                assertion.EqualsValue is null && Text(text, variables);
        return assertion.ContainsText is null && Field.IsMatch(assertion.Field ?? "") &&
            (assertion.Binding is null ? Scalar(assertion.EqualsValue, variables) : assertion.EqualsValue is null &&
                assertion.Binding is "build" or "identity" or "scope" or "role");
    }

    public static ExecutionIdentity ValidateResources(UatRun run, ExecutionIdentity identity)
    {
        var target = run.Target!;
        var actions = run.TestSnapshot.Workflow!.Steps.SelectMany(step => step.Actions).ToArray();
        var expected = actions.SelectMany(action => Captures(action.Http))
            .Select(capture => capture.ResourceKind).OfType<string>().ToHashSet(StringComparer.Ordinal);
        var companyExtension = actions.Any(action => action.Extension?.Id == "company-reopen");
        if (companyExtension) expected.Add("company");
        var resources = identity.Resources ?? [];
        if (resources.Length != expected.Count || !expected.SetEquals(resources.Select(r => r?.Kind).OfType<string>()) ||
            resources.Any(r => r is null || !Guid.TryParseExact(r.Id, "D", out var id) || r.ScopeId != target.ExpectedCompanyId ||
                (Guid.TryParse(target.ExpectedCompanyId, out var scope) && id == scope)) ||
            (companyExtension && !resources.Any(resource => resource is { Kind: "company" } && resource.Id == identity.CompanyId)) ||
            (target.ExpectedCompanyId is not null && identity.IsolationCompanyId != target.ExpectedCompanyId) ||
            (target.ExpectedRole is { } role && identity.Roles?.Contains(role) != true))
            throw new ArgumentException("The configured workflow must report the declared resources and verified target scope.");
        return identity with { Resources = resources };
    }

    public static void ValidateObservations(UatRun run, StepResult step)
    {
        var observations = step.ApiObservations ?? [];
        if (run.TestSnapshot.Workflow is not { } workflow)
        {
            if (step.ApiObservations is not null) throw new ArgumentException("This workflow does not report configured API observations.");
            return;
        }
        var requests = workflow.Steps.Single(definition => definition.StepId == step.StepId).Actions
            .Select(action => action.Http).OfType<WorkflowHttp>().ToArray();
        if (observations.Length > requests.Length || observations.Any(o => o is null || !LocalPath(o.Path) || o.Status is < 200 or > 599 ||
            o.Method is not ("GET" or "POST" or "PUT" or "PATCH" or "DELETE") || o.Session is { Length: > 40 }))
            throw new ArgumentException("Invalid API observations.");
        if (step.Status == "passed" && (observations.Length != requests.Length || observations.Zip(requests).Any(pair =>
            pair.First.Method != pair.Second.Method || pair.First.Status != pair.Second.Status || pair.First.Session != pair.Second.Session ||
            (!pair.Second.Path.Contains("{{") && pair.First.Path != pair.Second.Path))))
            throw new ArgumentException("A passing configured step must report every expected API status.");
    }
}
