using System.Net;
using System.Text.Json;

namespace Getright.Dashboard;

public sealed class ApplicationSetup(RunStore store, UatCatalogue catalogue, ILogger<ApplicationSetup> logger)
{
    public static void Validate(ApplicationProfile profile)
    {
        if (profile.ApplicationId != "writerapp") throw new ArgumentException("Only WriterApp setup is supported in milestone 1.");
        if (!Uri.TryCreate(profile.BaseUrl, UriKind.Absolute, out var url) || url.Scheme != "http" ||
            !url.IsLoopback || url.UserInfo != "" || url.AbsolutePath != "/" || url.Query != "" || url.Fragment != "" ||
            !(url.Host.Equals("localhost", StringComparison.OrdinalIgnoreCase) ||
              (IPAddress.TryParse(url.Host.Trim('[', ']'), out var address) && IPAddress.IsLoopback(address))))
            throw new ArgumentException("Use a loopback HTTP origin, such as http://localhost:5387, without a path or credentials.");
        if (string.IsNullOrWhiteSpace(profile.ExpectedBuildVersion) || profile.ExpectedBuildVersion.Length > 150 ||
            string.IsNullOrWhiteSpace(profile.ExpectedUserId) || profile.ExpectedUserId.Length > 150)
            throw new ArgumentException("Provide the expected running build version and dedicated UAT account ID (up to 150 characters each).");
        if (!profile.IsolatedDataConfirmed) throw new ArgumentException("Confirm that this instance uses isolated UAT data before enabling it.");
        if (profile.SourceCommit is not null && !System.Text.RegularExpressions.Regex.IsMatch(profile.SourceCommit, "^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$"))
            throw new ArgumentException("The source revision must be a Git commit hash when supplied.");
    }

    public async Task<ApplicationReadiness> Check(string applicationId, CancellationToken cancellationToken = default)
    {
        var profile = store.Profile(applicationId);
        if (profile is null) return new(false, "Configure the local WriterApp instance first.");
        return await Check(profile, cancellationToken);
    }
    private async Task<ApplicationReadiness> Check(ApplicationProfile profile, CancellationToken cancellationToken)
    {
        Validate(profile);
        using var client = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false, UseProxy = false })
            { BaseAddress = new Uri(profile.BaseUrl), Timeout = TimeSpan.FromSeconds(5) };
        try
        {
            using var versionResponse = await client.GetAsync("/api/app/version", cancellationToken);
            if (!versionResponse.IsSuccessStatusCode) return new(false, "WriterApp did not return its build version. Check the local instance and sign-in setup.");
            using var version = await JsonDocument.ParseAsync(await versionResponse.Content.ReadAsStreamAsync(cancellationToken), cancellationToken: cancellationToken);
            if (version.RootElement.ValueKind != JsonValueKind.Object) return new(false, "WriterApp did not return a valid build-version response.");
            var running = version.RootElement.TryGetProperty("version", out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;
            if (running != profile.ExpectedBuildVersion) return new(false, "The running build does not match the expected version. Start the intended build or update setup.", running);
            using var authResponse = await client.GetAsync("/api/auth/me", cancellationToken);
            if (!authResponse.IsSuccessStatusCode) return new(false, "The dedicated UAT account is unavailable. Start an isolated development instance with automatic test sign-in.", running);
            using var auth = await JsonDocument.ParseAsync(await authResponse.Content.ReadAsStreamAsync(cancellationToken), cancellationToken: cancellationToken);
            if (auth.RootElement.ValueKind != JsonValueKind.Object) return new(false, "WriterApp did not return a valid account response.", running);
            if (!auth.RootElement.TryGetProperty("isAuthenticated", out var authenticated) || authenticated.ValueKind != JsonValueKind.True ||
                !auth.RootElement.TryGetProperty("userId", out var user) || user.ValueKind != JsonValueKind.String || user.GetString() != profile.ExpectedUserId)
                return new(false, "WriterApp is not signed in as the configured UAT account. No test data was created.", running);
            return new(true, "Ready: the local build and dedicated UAT account match.", running);
        }
        catch (Exception exception) when (exception is HttpRequestException or TaskCanceledException or JsonException)
        {
            cancellationToken.ThrowIfCancellationRequested();
            logger.LogWarning("WriterApp readiness failed: {FailureType}: {Detail}", exception.GetType().Name, exception.Message);
            return new(false, "Cannot verify the local WriterApp instance. Check that it is running and returning the expected version and account.");
        }
    }
    public async Task<UatRun> Queue(string testId, CancellationToken cancellationToken = default)
    {
        var test = catalogue.Get(testId);
        if (test.ApplicationId != "writerapp") return store.Queue(testId);
        if (test.Adapter != "writerapp-create-save") throw new ArgumentException("This workflow's adapter is not implemented yet.");
        var profile = store.Profile("writerapp") ?? throw new ArgumentException("Configure the local WriterApp instance first.");
        var readiness = await Check(profile, cancellationToken);
        if (!readiness.Ready) throw new ArgumentException(readiness.Message);
        return store.Queue(testId, profile);
    }
}
