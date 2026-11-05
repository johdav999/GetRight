using System.Net;
using Microsoft.AspNetCore.DataProtection;
using Getright.Dashboard;
using Getright.Dashboard.Components;

var builder = WebApplication.CreateBuilder(args);
builder.WebHost.UseUrls(builder.Configuration["urls"] ?? "http://127.0.0.1:5120");
// Local source builds must serve framework/scoped assets outside Development too.
builder.WebHost.UseStaticWebAssets();
builder.WebHost.ConfigureKestrel(options => options.Limits.MaxRequestBodySize = 256 * 1024);
builder.Services.AddRazorComponents().AddInteractiveServerComponents()
    .AddHubOptions(options => options.MaximumReceiveMessageSize = 128 * 1024);
builder.Services.AddSingleton<UatCatalogue>();
builder.Services.AddSingleton<DashboardInstance>();
builder.Services.AddSingleton<RunStore>();
builder.Services.AddSingleton<ApplicationSetup>();
builder.Services.AddSingleton<LiveBrowser>();
builder.Services.AddSingleton<WorkerActivity>();
builder.Services.AddSingleton<CaseGeneration>();
builder.Services.AddHostedService<LeaseMonitor>();
var protection = builder.Services.AddDataProtection()
    .SetApplicationName("Getright")
    .PersistKeysToFileSystem(new DirectoryInfo(Path.Combine(RunStore.ResolveDataPath(builder.Configuration), "keys")));
if (OperatingSystem.IsWindows()) protection.ProtectKeysWithDpapi();
var app = builder.Build();
_ = app.Services.GetRequiredService<DashboardInstance>();
_ = app.Services.GetRequiredService<RunStore>();
if (!app.Environment.IsDevelopment()) app.UseExceptionHandler("/Error", createScopeForErrors: true);

// Local trusted-user application. Host validation also prevents DNS rebinding.
app.Use(async (context, next) =>
{
    var host = context.Request.Host.Host;
    var origin = context.Request.Headers.Origin.ToString();
    var localHost = host.Equals("localhost", StringComparison.OrdinalIgnoreCase) ||
        (IPAddress.TryParse(host.Trim('[', ']'), out var address) && IPAddress.IsLoopback(address));
    var sameOrigin = string.IsNullOrEmpty(origin) ||
        (Uri.TryCreate(origin, UriKind.Absolute, out var uri) &&
         uri.Authority.Equals(context.Request.Host.Value, StringComparison.OrdinalIgnoreCase) && uri.Scheme == context.Request.Scheme);
    if (!localHost || context.Connection.RemoteIpAddress is not { } remote || !IPAddress.IsLoopback(remote) || !sameOrigin)
    { context.Response.StatusCode = 403; return; }
    try { await next(context); }
    catch (ArgumentException exception) when (context.Request.Path.StartsWithSegments("/api"))
    { await Results.BadRequest(new { error = exception.Message }).ExecuteAsync(context); }
});
app.UseAntiforgery();
app.MapGet("/api/health", (DashboardInstance instance) => new { name = "Getright", version = AppJson.BuildVersion, mode = "local", instanceId = instance.Id, processId = Environment.ProcessId, dataPath = instance.DataPath });
app.MapGet("/api/operations/active", (RunStore store) => store.ActiveWork());
app.MapPost("/api/worker/presence/connect", (WorkerRegistration request, WorkerActivity workers) => workers.Connect(request));
app.MapPost("/api/worker/presence/{id}", (string id, WorkerPulse request, WorkerActivity workers) => { workers.Pulse(id, request); return Results.NoContent(); });
app.MapGet("/api/worker/status", (WorkerActivity workers) => workers.Snapshot());
app.MapGet("/api/catalog", (UatCatalogue catalogue, RunStore store) => new Catalogue(catalogue.Value.Applications, store.Tests()));
app.MapGet("/tests/{id}/open", TestPage.Open);
app.MapGet("/api/suites", (RunStore store) => store.Suites());
app.MapGet("/api/suites/{id}", (string id, RunStore store) => store.Suite(id));
app.MapPost("/api/suites", (CreateSuiteRequest request, RunStore store) => store.CreateSuite(request));
app.MapPost("/api/suites/{id}", (string id, EditSuiteRequest request, RunStore store) => store.EditSuite(id, request));
app.MapGet("/api/generation/status", (CaseGeneration generation) => generation.Status());
app.MapPost("/api/suites/{id}/generate", (string id, GenerateCasesRequest request, CaseGeneration generation, CancellationToken cancellationToken) => generation.Generate(id, request, cancellationToken));
app.MapGet("/api/suites/{id}/proposals", (string id, RunStore store) => store.Proposals(id));
app.MapPost("/api/suites/{id}/proposals/{proposalId}/apply", (string id, string proposalId, ApplyCasesRequest request, RunStore store) => store.ApplyProposal(id, proposalId, request));
app.MapGet("/api/runs", (RunStore store) => store.List());
app.MapGet("/api/runs/{id}", (string id, RunStore store) => store.Get(id));
app.MapPost("/api/runs", async (QueueRequest request, ApplicationSetup setup, CancellationToken cancellationToken) => Results.Created("/api/runs", await setup.Queue(request.TestId, cancellationToken, request.Docked, request.StepByStep)));
app.MapPost("/api/runs/{id}/browser/connect", (string id, BrowserConnect request, LiveBrowser browser) => browser.Connect(id, request));
app.MapPost("/api/runs/{id}/browser/frame", (string id, BrowserFrame request, LiveBrowser browser) => { browser.Frame(id, request); return Results.NoContent(); });
app.MapPost("/api/runs/{id}/browser/poll", (string id, BrowserWorker request, LiveBrowser browser) => browser.Poll(id, request));
app.MapPost("/api/runs/{id}/browser/end", (string id, BrowserWorker request, LiveBrowser browser) => { browser.End(id, request); return Results.NoContent(); });
app.MapGet("/api/runs/{id}/browser", (string id, LiveBrowser browser) => browser.Status(id));
app.MapGet("/api/runs/{id}/browser/frame", (string id, HttpContext context, LiveBrowser browser) => {
    context.Response.Headers.CacheControl = "no-store";
    return browser.Image(id) is { } bytes ? Results.File(bytes, "image/jpeg") : Results.NoContent();
});
app.MapPost("/api/runs/{id}/browser/input", (string id, BrowserInput input, LiveBrowser browser) => { browser.Input(id, input); return Results.NoContent(); });
app.MapPost("/api/runs/{id}/browser/close", (string id, string? reason, LiveBrowser browser) => { browser.Close(id, reason); return Results.NoContent(); });
app.MapPost("/api/runs/{id}/browser/step", (string id, BrowserStep request, LiveBrowser browser) => browser.Step(id, request));
app.MapPost("/api/runs/{id}/browser/advance", (string id, BrowserAdvance request, LiveBrowser browser) => { browser.Advance(id, request); return Results.NoContent(); });
app.MapGet("/api/applications/{id}/profile", (string id, RunStore store) => Results.Ok(store.Profile(id)));
app.MapPost("/api/applications/{id}/profile", (string id, ApplicationProfile profile, RunStore store) =>
{
    if (profile.ApplicationId != id) throw new ArgumentException("The profile belongs to a different application.");
    return store.SaveProfile(profile);
});
app.MapGet("/api/applications/{id}/readiness", (string id, ApplicationSetup setup, CancellationToken cancellationToken) => setup.Check(id, cancellationToken));
app.MapPost("/api/worker/claim", (WorkerClaimRequest? request, RunStore store) => store.Claim(request?.WorkflowEngineDigest, request?.SupportsStepControl ?? false) is { } lease ? Results.Ok(lease) : Results.NoContent());
app.MapGet("/api/case-implementations", (string? test, RunStore store) => store.CaseJobs(test));
app.MapGet("/api/case-implementations/{id}", (string id, RunStore store) => store.CaseJob(id));
app.MapPost("/api/tests/{id}/approve-implementation", (string id, ApproveCaseRequest request, ApplicationSetup setup, CancellationToken cancellationToken) => setup.ApproveCase(id, request, cancellationToken));
app.MapGet("/api/tests/{id}/implementation-readiness", (string id, RunStore store) => store.ImplementationReadiness(id));
app.MapPost("/api/case-implementations/{id}/retry", (string id, ApproveCaseRequest request, ApplicationSetup setup, CancellationToken cancellationToken) => setup.RetryCase(id, request, cancellationToken));
app.MapPost("/api/tests/{id}/disable-implementation", (string id, RunStore store) => store.DisableCase(id));
app.MapPost("/api/worker/case-implementations/claim", (RunStore store) => store.ClaimCaseJob() is { } lease ? Results.Ok(lease) : Results.NoContent());
app.MapPost("/api/worker/case-implementations/claim-batch", (RunStore store) => store.ClaimCaseBatch() is { } batch ? Results.Ok(batch) : Results.NoContent());
app.MapPost("/api/case-implementations/{id}/heartbeat", (string id, JobLeaseRequest request, RunStore store) => store.HeartbeatCaseJob(id, request.Lease));
app.MapPost("/api/case-implementations/{id}/report", (string id, CaseImplementationReport request, RunStore store) => store.ReportCaseJob(id, request));
app.MapPost("/api/case-implementations/{id}/validate", (string id, CaseValidationRequest request, RunStore store) => store.CreateCaseValidation(id, request));
app.MapPost("/api/case-implementations/{id}/finish", (string id, CaseImplementationFinish request, RunStore store) => store.FinishCaseJob(id, request));
app.MapPost("/api/case-implementations/{id}/cancel", (string id, RunStore store) => store.CancelCaseJob(id));
app.MapGet("/api/case-implementations/{id}/events", (string id, long? after, RunStore store) => store.CaseEvents(id, after ?? 0));
app.MapGet("/api/case-implementations/{id}/artifacts/{file}", (string id, string file, RunStore store) =>
{
    _ = store.CaseJob(id);
    if (file is not ("codex.log" or "build.log" or "summary.json" or "workflow.json" or "shared-build.json")) return Results.NotFound();
    var artifact = Path.Combine(store.DataPath, "case-implementations", id, file);
    return File.Exists(artifact) ? Results.File(artifact, file.EndsWith(".json") ? "application/json" : "text/plain", file) : Results.NotFound();
});
app.MapGet("/api/history", (int? page, int? pageSize, string? test, string? application, string? status, string? acceptance, long? snapshot, RunStore store) => store.History(page ?? 1, pageSize ?? 20, test, application, status, acceptance, snapshot));
app.MapGet("/api/job-history", (int? page, int? pageSize, string? application, string? status, long? snapshot, RunStore store) => store.JobHistory(page ?? 1, pageSize ?? 20, application, status, snapshot));
app.MapPost("/api/runs/{id}/heartbeat", (string id, JobLeaseRequest request, RunStore store) => store.HeartbeatRun(id, request.Lease));
app.MapPost("/api/runs/{id}/cancel", (string id, RunStore store) => store.CancelRun(id));
app.MapGet("/api/runs/{id}/reviews", (string id, long? after, RunStore store) => store.ReviewHistory(id, after ?? 0));
app.MapGet("/api/maintenance/preview-page", (int? days, int? page, RunStore store) => store.PreviewCleanupBatch(days ?? 30, page ?? 1));
app.MapGet("/api/maintenance/history", (int? page, long? snapshot, RunStore store) => store.CleanupHistory(page ?? 1, snapshot));
app.MapGet("/api/maintenance/preview", (int? days, RunStore store) => store.CleanupPreview(days ?? 30));
app.MapGet("/api/maintenance/tasks", (RunStore store) => store.Cleanups());
app.MapPost("/api/maintenance/tasks", (CleanupRequest request, RunStore store) => store.RequestCleanup(request));
app.MapPost("/api/maintenance/tasks/{id}/cancel", (string id, RunStore store) => store.CancelCleanup(id));
app.MapPost("/api/worker/cleanup/claim", (RunStore store) => store.ClaimCleanup() is { } claim ? Results.Ok(claim) : Results.NoContent());
app.MapPost("/api/maintenance/tasks/{id}/heartbeat", (string id, JobLeaseRequest request, RunStore store) => store.HeartbeatCleanup(id, request.Lease));
app.MapPost("/api/maintenance/tasks/{id}/finish", (string id, CleanupFinish request, RunStore store) => store.FinishCleanup(id, request));
app.MapPost("/api/runs/{id}/complete", (string id, CompletionRequest request, RunStore store) => store.Complete(id, request));
app.MapPost("/api/runs/{id}/review", (string id, ReviewRequest request, RunStore store) => store.Review(id, request.Acceptance));
app.MapGet("/api/runs/{id}/feedback", (string id, RunStore store) => store.FeedbackFor(id));
app.MapGet("/api/jobs", (RunStore store) => store.Jobs());
app.MapPost("/api/jobs", (CreateJobRequest request, RunStore store) => store.CreateJob(request.RunId, request.FeedbackId));
app.MapGet("/api/jobs/{id}", (string id, RunStore store) => store.Job(id));
app.MapPost("/api/jobs/{id}/draft", (string id, EditJobRequest request, RunStore store) => store.EditJob(id, request));
app.MapPost("/api/jobs/{id}/start", (string id, StartJobRequest request, RunStore store) => store.StartJob(id, request.Revision));
app.MapPost("/api/jobs/{id}/cancel", (string id, RunStore store) => store.CancelJob(id));
app.MapPost("/api/worker/jobs/claim", (RunStore store) => store.ClaimJob() is { } claim ? Results.Ok(claim) : Results.NoContent());
app.MapPost("/api/jobs/{id}/heartbeat", (string id, JobLeaseRequest request, RunStore store) => store.HeartbeatJob(id, request.Lease));
app.MapPost("/api/jobs/{id}/report", (string id, JobReport request, RunStore store) => store.ReportJob(id, request));
app.MapPost("/api/jobs/{id}/rerun", (string id, JobRerunRequest request, RunStore store) => store.CreateJobRerun(id, request));
app.MapPost("/api/jobs/{id}/finish", (string id, JobFinish request, RunStore store) => store.FinishJob(id, request));
app.MapGet("/api/jobs/{id}/events", (string id, long? after, RunStore store) => store.JobEvents(id, after ?? 0));
app.MapGet("/api/jobs/{id}/artifacts/{file}", (string id, string file, RunStore store) =>
{
    var path = store.JobArtifactPath(id, file);
    return path is not null && File.Exists(path) ? Results.File(path, file == "summary.json" ? "application/json" : "text/plain", file) : Results.NotFound();
});
app.MapPost("/api/runs/{id}/feedback", (string id, FeedbackRequest request, RunStore store) => store.AddFeedback(id, request));
app.MapGet("/api/runs/{id}/tasks/{feedbackId}", (string id, string feedbackId, RunStore store) =>
{
    var feedback = store.FeedbackFor(id).FirstOrDefault(f => f.Id == feedbackId);
    return feedback is null ? Results.NotFound() : Results.File(System.Text.Encoding.UTF8.GetBytes(feedback.Prompt),
        "text/plain", $"getright-{feedback.Id}.txt");
});
app.MapGet("/api/evidence/{id}/{file}", (string id, string file, RunStore store) =>
{
    var path = store.EvidencePath(id, file);
    if (path is null || !File.Exists(path)) return Results.NotFound();
    return Results.File(path, file.EndsWith(".png", StringComparison.OrdinalIgnoreCase) ? "image/png" : "application/zip");
});
app.MapStaticAssets();
app.MapRazorComponents<App>().AddInteractiveServerRenderMode();
app.Run();
