using System.Net;
using Microsoft.AspNetCore.DataProtection;
using Getright.Dashboard;
using Getright.Dashboard.Components;

var builder = WebApplication.CreateBuilder(args);
builder.WebHost.UseUrls(builder.Configuration["urls"] ?? "http://127.0.0.1:5120");
// Local source builds must serve framework/scoped assets outside Development too.
builder.WebHost.UseStaticWebAssets();
builder.WebHost.ConfigureKestrel(options => options.Limits.MaxRequestBodySize = 64 * 1024);
builder.Services.AddRazorComponents().AddInteractiveServerComponents();
builder.Services.AddSingleton<UatCatalogue>();
builder.Services.AddSingleton<RunStore>();
builder.Services.AddSingleton<ApplicationSetup>();
var protection = builder.Services.AddDataProtection()
    .SetApplicationName("Getright")
    .PersistKeysToFileSystem(new DirectoryInfo(Path.Combine(RunStore.ResolveDataPath(builder.Configuration), "keys")));
if (OperatingSystem.IsWindows()) protection.ProtectKeysWithDpapi();
var app = builder.Build();
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
app.MapGet("/api/health", () => new { name = "Getright", version = AppJson.BuildVersion, mode = "local" });
app.MapGet("/api/catalog", (UatCatalogue catalogue) => catalogue.Value);
app.MapGet("/api/runs", (RunStore store) => store.List());
app.MapGet("/api/runs/{id}", (string id, RunStore store) => store.Get(id));
app.MapPost("/api/runs", async (QueueRequest request, ApplicationSetup setup, CancellationToken cancellationToken) => Results.Created("/api/runs", await setup.Queue(request.TestId, cancellationToken)));
app.MapGet("/api/applications/{id}/profile", (string id, RunStore store) => Results.Ok(store.Profile(id)));
app.MapPost("/api/applications/{id}/profile", (string id, ApplicationProfile profile, RunStore store) =>
{
    if (profile.ApplicationId != id) throw new ArgumentException("The profile belongs to a different application.");
    return store.SaveProfile(profile);
});
app.MapGet("/api/applications/{id}/readiness", (string id, ApplicationSetup setup, CancellationToken cancellationToken) => setup.Check(id, cancellationToken));
app.MapPost("/api/worker/claim", (RunStore store) => store.Claim() is { } lease ? Results.Ok(lease) : Results.NoContent());
app.MapPost("/api/runs/{id}/complete", (string id, CompletionRequest request, RunStore store) => store.Complete(id, request));
app.MapPost("/api/runs/{id}/review", (string id, ReviewRequest request, RunStore store) => store.Review(id, request.Acceptance));
app.MapGet("/api/runs/{id}/feedback", (string id, RunStore store) => store.FeedbackFor(id));
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
