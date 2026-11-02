using System.Net.Http.Json;
using System.Reflection;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.EntityFrameworkCore;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Configuration;
using VirtualCompany.Api.Tests;
using VirtualCompany.Domain.Entities;
using VirtualCompany.Domain.Enums;

// This harness composes the real API with the repository's isolated SQLite test
// factory. It is never a production host and never loads the user's .env file.
using var factory = new IsolatedFactory();
var reference = Guid.Parse("04040404-0404-0404-0404-040404040404");
await factory.SeedAsync(async db =>
{
    var owner = new User(Guid.NewGuid(), "getright-owner@example.invalid", "Getright owner", "dev-header", "getright-owner");
    var employee = new User(Guid.NewGuid(), "getright-employee@example.invalid", "Getright employee", "dev-header", "getright-employee");
    var company = new Company(reference, "Getright isolation reference");
    company.UpdateWorkspaceProfile(company.Name, null, null, "Europe/Stockholm", "SEK", "en", "SE");
    company.CompleteOnboarding(1, null, "{}");
    db.AddRange(owner, employee, company,
        new CompanyMembership(Guid.NewGuid(), reference, owner.Id, CompanyMembershipRole.Owner, CompanyMembershipStatus.Active),
        new CompanyMembership(Guid.NewGuid(), reference, employee.Id, CompanyMembershipRole.Employee, CompanyMembershipStatus.Active));
    await db.SaveChangesAsync();
});
using var api = factory.CreateClient(new() { AllowAutoRedirect = false });
var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();
var version = typeof(VirtualCompany.Api.Controllers.AuthController).Assembly.GetName().Version!.ToString();
var webAssembly = Environment.GetEnvironmentVariable("GETRIGHT_WEB_ASSEMBLY") ?? Path.Combine(Environment.CurrentDirectory, "src/VirtualCompany.Web/bin/Debug/net9.0/VirtualCompany.Web.dll");
if (Assembly.GetExecutingAssembly().GetName().Version!.ToString() != version || AssemblyName.GetAssemblyName(webAssembly).Version!.ToString() != version)
    throw new InvalidOperationException("The loaded API, harness and compiled web assembly must identify the same build.");
app.Run(async context =>
{
    if (context.Request.Path == "/_getright/prepare-company" && context.Request.Method == "POST" && Guid.TryParse(context.Request.Query["companyId"], out var companyId))
    {
        // Fixture prerequisites only. The actual permission write is always made
        // by the UI. No credentials are supplied and no transport or background worker is invoked.
        await factory.SeedAsync(async db =>
        {
            var owner = await db.Users.SingleAsync(x => x.AuthSubject == "getright-owner");
            if (companyId == reference || !await db.TestCompanyProfiles.IgnoreQueryFilters().AnyAsync(x => x.CompanyId == companyId && x.CreatedByUserId == owner.Id))
                throw new InvalidOperationException("Only this isolated owner's created test companies can receive fixture prerequisites.");
            if (!await db.MailboxConnections.IgnoreQueryFilters().AnyAsync(x => x.CompanyId == companyId))
            {
                var mailbox = new MailboxConnection(Guid.NewGuid(), companyId, owner.Id, MailboxProvider.StandardEmail,
                    "getright-sender@example.invalid", "Disconnected Getright fixture sender");
                mailbox.SetStatus(MailboxConnectionStatus.Active);
                mailbox.SetCapabilities(MailboxCapability.SendMessages | MailboxCapability.ReadMessages);
                var employee = await db.Users.SingleAsync(x => x.AuthSubject == "getright-employee");
                db.AddRange(mailbox, new CompanyMembership(Guid.NewGuid(), companyId, employee.Id, CompanyMembershipRole.Employee, CompanyMembershipStatus.Active));
                await db.SaveChangesAsync();
            }
        });
        await context.Response.WriteAsJsonAsync(new { companyId, fixture = "Disconnected sender and employee membership only; no credentials or external transport" });
        return;
    }
    if (context.Request.Path == "/_getright/runtime")
    {
        using var identityRequest = new HttpRequestMessage(HttpMethod.Get, "/api/auth/me");
        identityRequest.Headers.Add("X-Dev-Auth-Subject", "getright-owner");
        using var identityResponse = await api.SendAsync(identityRequest, context.RequestAborted);
        identityResponse.EnsureSuccessStatusCode();
        var json = new JsonSerializerOptions(JsonSerializerDefaults.Web);
        json.Converters.Add(new JsonStringEnumConverter(JsonNamingPolicy.SnakeCaseLower));
        var identity = (await identityResponse.Content.ReadFromJsonAsync<VirtualCompany.Application.Companies.CurrentUserContextDto>(json, context.RequestAborted))!;
        var membership = identity.Memberships.Single(x => x.CompanyId == reference);
        await context.Response.WriteAsJsonAsync(new { version, userId = identity.User.Id.ToString(), companyId = reference.ToString(),
            role = membership.MembershipRole.ToString().ToLowerInvariant(), isolated = true }, context.RequestAborted);
        return;
    }
    using var request = new HttpRequestMessage(new HttpMethod(context.Request.Method), context.Request.Path + context.Request.QueryString);
    if (context.Request.ContentLength > 0 || context.Request.Headers.ContainsKey("Transfer-Encoding")) request.Content = new StreamContent(context.Request.Body);
    foreach (var header in context.Request.Headers.Where(x => !string.Equals(x.Key, "Host", StringComparison.OrdinalIgnoreCase)))
        if (!request.Headers.TryAddWithoutValidation(header.Key, header.Value.ToArray()) && request.Content is not null)
            request.Content.Headers.TryAddWithoutValidation(header.Key, header.Value.ToArray());
    if (!request.Headers.Contains("X-Dev-Auth-Subject")) request.Headers.Add("X-Dev-Auth-Subject", "getright-owner");
    using var response = await api.SendAsync(request, context.RequestAborted);
    context.Response.StatusCode = (int)response.StatusCode;
    foreach (var header in response.Headers.Concat(response.Content.Headers)) context.Response.Headers[header.Key] = header.Value.ToArray();
    context.Response.Headers.Remove("transfer-encoding");
    await response.Content.CopyToAsync(context.Response.Body, context.RequestAborted);
});
await app.RunAsync();

sealed class IsolatedFactory : TestWebApplicationFactory
{
    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        base.ConfigureWebHost(builder);
        builder.UseContentRoot(Path.Combine(Environment.CurrentDirectory, "src", "VirtualCompany.Api"));
        builder.ConfigureAppConfiguration((_, configuration) => configuration.AddInMemoryCollection(new Dictionary<string, string?>
        { ["TestCompanies:CreationEnabled"] = "true" }));
    }
}
