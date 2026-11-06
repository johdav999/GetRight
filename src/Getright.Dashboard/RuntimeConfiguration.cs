using System.Net;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Getright.Dashboard;

public record RuntimePlan(int Version, RuntimeIdentity[] Identities, FixtureRecipe[]? Fixtures = null);
public record RuntimeIdentity(string Name, RuntimeCheck[] Checks, string? Subject = null, TestLogin? Form = null);
public record TestLogin(string Path, string UsernameRef, string PasswordRef, string UsernameField = "username", string PasswordField = "password", int? Status = null);
public record RuntimeCheck(string Path, RuntimeAssertion[]? Assertions = null, int Status = 200, int Attempts = 1);
public record RuntimeAssertion(string Field, JsonElement? EqualsValue = null, string? Binding = null, RuntimeAssertion[]? Contains = null);
public record FixtureRecipe(string Kind, string Identity, Dictionary<string, string>? Values = null, int DeleteStatus = 204);
public record FixtureResult(string Kind, string? Id, string Status);
public record RuntimeResult(bool VerifiedAfter, FixtureResult[] Fixtures);

public static class RuntimeConfiguration
{
    public const int Version = 1;
    private static bool Identifier(string? value) => value is not null && Regex.IsMatch(value, @"\A[a-z][a-z0-9-]{0,39}\z");
    private static bool Field(string? value) => value is not null && Regex.IsMatch(value, @"\A[A-Za-z_][A-Za-z0-9_]{0,39}(?:\.[A-Za-z_][A-Za-z0-9_]{0,39}){0,4}\z");
    private static bool SecretRef(string? value) => value is not null && Regex.IsMatch(value, @"\AGETRIGHT_UAT_[A-Z0-9_]{1,64}\z");
    private static bool Path(string? value) => value is { Length: <= 180 } && Regex.IsMatch(value, @"\A(?:/[A-Za-z0-9_-]+)+\z");
    private static bool Status(int value) => value is >= 200 and <= 299;

    private static bool Valid(RuntimeAssertion? assertion, bool nested = false)
    {
        if (assertion is null || !Field(assertion.Field)) return false;
        if (assertion.Contains is { } members)
            return !nested && assertion.Binding is null && assertion.EqualsValue is null && members.Length is >= 1 and <= 6 && members.All(m => Valid(m, true));
        if (assertion.Binding is not null)
            return assertion.EqualsValue is null && assertion.Binding is "build" or "identity" or "scope" or "role";
        return assertion.EqualsValue is { ValueKind: JsonValueKind.True or JsonValueKind.False } ||
            (assertion.EqualsValue is { ValueKind: JsonValueKind.String } value && value.GetString()!.Length <= 150) ||
            (assertion.EqualsValue is { ValueKind: JsonValueKind.Number } number && number.TryGetInt32(out _));
    }

    private static bool Valid(RuntimeCheck? check) => check is not null && Path(check.Path) && check.Status is >= 200 and <= 599 &&
        check.Attempts is >= 1 and <= 3 && (check.Assertions is null || (check.Assertions.Length <= 8 && check.Assertions.All(a => Valid(a))));

    private static bool HasBinding(RuntimeIdentity identity, string binding) =>
        identity.Checks.SelectMany(check => check.Assertions ?? []).Any(assertion => assertion.Binding == binding);

    private static bool Valid(RuntimeIdentity? identity)
    {
        if (identity is null || !Identifier(identity.Name) || identity.Subject is { Length: 0 or > 150 } ||
            identity.Checks is not { Length: >= 1 and <= 6 } || !identity.Checks.All(Valid) || !HasBinding(identity, "identity")) return false;
        if (identity.Form is not { } form) return true;
        return Path(form.Path) && SecretRef(form.UsernameRef) && SecretRef(form.PasswordRef) && Field(form.UsernameField) &&
            Field(form.PasswordField) && form.UsernameField != form.PasswordField &&
            (form.Status is not { } status || Status(status) || status is 302 or 303);
    }

    private static bool Valid(FixtureRecipe? fixture, RuntimeIdentity[] identities) => fixture is not null && Identifier(fixture.Kind) &&
        identities.Any(identity => identity.Name == fixture.Identity) && Status(fixture.DeleteStatus) &&
        (fixture.Values is null || (fixture.Values.Count <= 6 && fixture.Values.All(value =>
            Identifier(value.Key) && value.Value is "fixture-id" or "name" or "email")));

    public static void Validate(RuntimePlan plan, string application)
    {
        if (plan.Version != Version || plan.Identities is not { Length: >= 1 and <= 4 } ||
            !plan.Identities.All(Valid) || plan.Identities[0] is not { Form: null, Subject: null } || !HasBinding(plan.Identities[0], "build") ||
            plan.Identities.Select(i => i.Name).Distinct().Count() != plan.Identities.Length ||
            plan.Fixtures is { Length: > 6 } || (plan.Fixtures ?? []).Any(f => !Valid(f, plan.Identities)) ||
            (plan.Fixtures ?? []).Select(f => f.Kind).Distinct().Count() != (plan.Fixtures?.Length ?? 0))
            throw new InvalidOperationException($"Invalid runtime plan for {application}. Check the version, identity checks, local paths and fixture recipes.");
    }

    public static void RequireIsolatedTarget(RuntimePlan plan)
    {
        if (!plan.Identities[0].Checks.Any(check => check.Path == "/_getright/runtime" && check.Status == 200 &&
            check.Assertions is { } assertions && assertions.Any(a => a.Field == "version" && a.Binding == "build") &&
            assertions.Any(a => a.Field == "userId" && a.Binding == "identity") &&
            assertions.Any(a => a.Field == "isolated" && a.EqualsValue is { ValueKind: JsonValueKind.True })))
            throw new InvalidOperationException("A configured target must attest to its isolated build and account at /_getright/runtime.");
    }

    public static async Task Check(RuntimePlan plan, ApplicationProfile target, CancellationToken cancellationToken)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        deadline.CancelAfter(TimeSpan.FromSeconds(12));
        var token = deadline.Token;
        foreach (var identity in plan.Identities)
        {
            using var client = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false, UseProxy = false, CookieContainer = new() })
                { BaseAddress = new Uri(target.BaseUrl), Timeout = TimeSpan.FromSeconds(3), MaxResponseContentBufferSize = 65536 };
            if (identity.Form is { } login)
            {
                var username = Environment.GetEnvironmentVariable(login.UsernameRef);
                var password = Environment.GetEnvironmentVariable(login.PasswordRef);
                if (string.IsNullOrEmpty(username) || string.IsNullOrEmpty(password))
                    throw new InvalidOperationException($"Set the local credential references for test identity '{identity.Name}'.");
                using var content = new FormUrlEncodedContent(new Dictionary<string, string> { [login.UsernameField] = username, [login.PasswordField] = password });
                using var response = await client.PostAsync(login.Path, content, token);
                var signedIn = login.Status is { } status ? (int)response.StatusCode == status : response.IsSuccessStatusCode;
                if (!signedIn) throw new InvalidOperationException($"Form sign-in failed for test identity '{identity.Name}'.");
            }
            foreach (var check in identity.Checks)
            {
                for (var attempt = 1; ; attempt++)
                {
                    if (await Matches(client, check, target, identity, token)) break;
                    if (attempt == check.Attempts)
                    {
                        var detail = check.Assertions?.Any(assertion => assertion.Binding == "build") == true ?
                            $" The running build does not match the expected build '{target.ExpectedBuildVersion}' or could not be verified." : "";
                        throw new InvalidOperationException($"Runtime check {check.Path} failed for test identity '{identity.Name}'.{detail} No test data was created.");
                    }
                    await Task.Delay(150, token);
                }
            }
            if (plan.Fixtures?.Any(f => f.Identity == identity.Name) == true)
            {
                var assertions = new List<RuntimeAssertion>
                {
                    new("isolated", JsonSerializer.SerializeToElement(true)), new("version", Binding: "build"), new("userId", Binding: "identity")
                };
                if (target.ExpectedCompanyId is not null) assertions.Add(new("companyId", Binding: "scope"));
                if (!await Matches(client, new("/_getright/fixtures", [.. assertions]), target, identity, token))
                    throw new InvalidOperationException($"The isolated fixture capability could not be verified for test identity '{identity.Name}'.");
            }
        }
    }

    private static async Task<bool> Matches(HttpClient client, RuntimeCheck check, ApplicationProfile target, RuntimeIdentity identity, CancellationToken token)
    {
        try
        {
            using var response = await client.GetAsync(check.Path, token);
            if ((int)response.StatusCode != check.Status) return false;
            if (check.Assertions is not { Length: > 0 } assertions) return true;
            using var json = JsonDocument.Parse(await response.Content.ReadAsByteArrayAsync(token));
            return assertions.All(a => Matches(json.RootElement, a, target, identity));
        }
        catch (JsonException) { return false; }
        catch (HttpRequestException) { return false; }
        catch (OperationCanceledException) when (!token.IsCancellationRequested) { return false; }
    }

    private static bool Matches(JsonElement value, RuntimeAssertion assertion, ApplicationProfile target, RuntimeIdentity identity)
    {
        foreach (var field in assertion.Field.Split('.'))
            if (value.ValueKind != JsonValueKind.Object || !value.TryGetProperty(field, out value)) return false;
        if (assertion.Contains is { } members)
            return value.ValueKind == JsonValueKind.Array && value.EnumerateArray().Any(item => members.All(m => Matches(item, m, target, identity)));
        if (assertion.EqualsValue is { } expected) return JsonElement.DeepEquals(value, expected);
        var binding = assertion.Binding switch
        {
            "build" => target.ExpectedBuildVersion,
            "identity" => identity.Subject ?? target.ExpectedUserId,
            "scope" => target.ExpectedCompanyId,
            "role" => target.ExpectedRole,
            _ => null
        };
        return binding is not null && value.ValueKind == JsonValueKind.String && value.GetString() == binding;
    }

    public static void ValidateResult(RuntimePlan? plan, RuntimeResult? result, bool passed)
    {
        if (plan is null && result is not null) throw new ArgumentException("This run has no configured runtime lifecycle.");
        if (plan is null) return;
        var recipes = plan.Fixtures ?? [];
        if (result is not null && (result.Fixtures is null || result.Fixtures.Length > recipes.Length ||
            result.Fixtures.Any(f => f is null || !recipes.Any(r => r.Kind == f.Kind) ||
                (f.Status == "setup-failed" ? f.Id is not null : f.Status is not ("deleted" or "cleanup-failed") || !Guid.TryParseExact(f.Id, "D", out _))) ||
            result.Fixtures.Select(f => f.Kind).Distinct().Count() != result.Fixtures.Length))
            throw new ArgumentException("Invalid fixture lifecycle result.");
        if (passed && (result is not { VerifiedAfter: true } || result.Fixtures.Length != recipes.Length || result.Fixtures.Any(f => f.Status != "deleted")))
            throw new ArgumentException("Passing runs require verified runtime and successful configured fixture cleanup.");
    }
}
