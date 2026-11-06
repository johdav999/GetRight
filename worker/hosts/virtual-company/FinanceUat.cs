using System.Collections.Concurrent;
using System.Globalization;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using VirtualCompany.Api.Tests;
using VirtualCompany.Application.Agents;
using VirtualCompany.Application.Finance;
using VirtualCompany.Domain.Entities;
using VirtualCompany.Domain.Enums;

// Installed only in the Getright-owned, loopback SQLite harness.
sealed class FinanceUat : IAgentReasoningGateway
{
    public static readonly DateTimeOffset AsOf = new(2026, 10, 15, 10, 0, 0, TimeSpan.Zero);
    private const string Requester = "getright-finance-requester";
    private const string Approver = "getright-finance-approver";
    private readonly ConcurrentDictionary<Guid, Lazy<Task<Fixture>>> fixtures = new();

    public async Task<bool> TryHandleAsync(HttpContext context, TestWebApplicationFactory factory)
    {
        var request = context.Request;
        if (!request.Path.StartsWithSegments("/_getright/finance", out var remainder)) return false;
        var parts = remainder.Value?.Split('/', StringSplitOptions.RemoveEmptyEntries) ?? [];
        if (parts.Length is < 1 or > 2 || !Guid.TryParseExact(parts[0], "N", out var runId))
        {
            context.Response.StatusCode = 404;
            return true;
        }

        var operation = parts.Length == 2 ? parts[1] : "";
        if (request.Method == "POST" && operation == "")
        {
            var fixture = await fixtures.GetOrAdd(runId, id => new Lazy<Task<Fixture>>(() => SeedAsync(factory, id))).Value;
            context.Response.StatusCode = 201;
            await context.Response.WriteAsJsonAsync(fixture, context.RequestAborted);
            return true;
        }
        if (!fixtures.TryGetValue(runId, out var existing))
        {
            context.Response.StatusCode = 404;
            return true;
        }
        var owned = await existing.Value;
        if (request.Method == "GET" && operation == "state")
        {
            await factory.SeedAsync(async db =>
            {
                var transaction = await db.FinanceTransactions.IgnoreQueryFilters().SingleAsync(x => x.Id == owned.TransactionId);
                var attempts = await db.ToolExecutionAttempts.IgnoreQueryFilters().Where(x => x.CompanyId == owned.CompanyId)
                    .Select(x => new { x.Id, x.ToolName, Status = x.Status.ToString(), x.DenialReason }).ToListAsync();
                var approvals = await db.ApprovalRequests.IgnoreQueryFilters().Where(x => x.CompanyId == owned.CompanyId)
                    .Select(x => new { x.Id, Status = x.Status.ToString(), x.TargetEntityId }).ToListAsync();
                var invoices = await db.FinanceInvoices.IgnoreQueryFilters().Where(x => x.Id == owned.InvoiceId ||
                    x.Id == owned.AlternateInvoiceId || x.Id == owned.ForeignInvoiceId)
                    .OrderBy(x => x.Id).Select(x => new { x.Id, x.CompanyId, x.InvoiceNumber, x.UpdatedUtc }).ToListAsync();
                await context.Response.WriteAsJsonAsync(new
                {
                    Category = transaction.TransactionType,
                    transaction.CreatedUtc,
                    transaction.TransactionUtc,
                    transaction.AccountId,
                    transaction.Amount,
                    transaction.Currency,
                    transaction.Description,
                    attempts,
                    approvals,
                    invoices
                });
            });
        }
        else if (request.Method == "POST" && operation == "change-target")
        {
            await factory.SeedAsync(async db =>
            {
                var row = await db.FinanceTransactions.IgnoreQueryFilters().SingleAsync(x => x.Id == owned.TransactionId &&
                    x.CompanyId == owned.CompanyId);
                row.ChangeCategory("travel");
                await db.SaveChangesAsync();
            });
            context.Response.StatusCode = 204;
        }
        else context.Response.StatusCode = 404;
        return true;
    }

    private static async Task<Fixture> SeedAsync(TestWebApplicationFactory factory, Guid runId)
    {
        var fixture = new Fixture(runId, Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid(),
            Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid());
        await factory.SeedAsync(async db =>
        {
            var company = CreateCompany(fixture.CompanyId, $"Getright Finance {runId:N}");
            var foreign = CreateCompany(fixture.ForeignCompanyId, $"Getright Finance reference {runId:N}");
            var requester = new User(fixture.RequesterId, $"{Requester}-{runId:N}@example.invalid", "Finance requester",
                "dev-header", fixture.RequesterSubject);
            var approver = new User(fixture.ApproverId, $"{Approver}-{runId:N}@example.invalid", "Finance approver",
                "dev-header", fixture.ApproverSubject);
            db.AddRange(company, foreign, requester, approver,
                new CompanyMembership(Guid.NewGuid(), company.Id, requester.Id, CompanyMembershipRole.Manager, CompanyMembershipStatus.Active),
                new CompanyMembership(Guid.NewGuid(), company.Id, approver.Id, CompanyMembershipRole.Owner, CompanyMembershipStatus.Active),
                new CompanyMembership(Guid.NewGuid(), foreign.Id, approver.Id, CompanyMembershipRole.Owner, CompanyMembershipStatus.Active),
                new Agent(fixture.AgentId, company.Id, "finance", "Laura", "Finance Manager", "Finance", null,
                    AgentSeniority.Senior, AgentStatus.Active, autonomyLevel: AgentAutonomyLevel.Level2,
                    tools: new Dictionary<string, JsonNode?>
                    {
                        ["allowed"] = new JsonArray("get_cash_balance", "list_invoices_awaiting_approval",
                            "recommend_transaction_category", "categorize_transaction"),
                        ["actions"] = new JsonArray("read", "recommend", "execute")
                    },
                    scopes: new Dictionary<string, JsonNode?>
                    {
                        ["read"] = new JsonArray("finance"), ["recommend"] = new JsonArray("finance"),
                        ["execute"] = new JsonArray("finance")
                    },
                    thresholds: new Dictionary<string, JsonNode?> { ["approval"] = new JsonObject { ["financeMutationUsd"] = 100 } }));
            var now = AsOf.UtcDateTime;
            var vendor = new FinanceCounterparty(Guid.NewGuid(), company.Id, "Synthetic Cloud Software", "vendor");
            var customer = new FinanceCounterparty(Guid.NewGuid(), company.Id, "Synthetic A Customer", "customer");
            var alternate = new FinanceCounterparty(Guid.NewGuid(), company.Id, "Synthetic Alternate Customer", "customer");
            var foreignCustomer = new FinanceCounterparty(Guid.NewGuid(), foreign.Id, "Getright Foreign Canary", "customer");
            db.AddRange(vendor, customer, alternate, foreignCustomer,
                new FinanceAccount(fixture.CashAccountId, company.Id, "1930", "Operating Cash", "asset", "SEK", 12345.67m, now.AddDays(-1)),
                new FinanceAccount(fixture.TransactionAccountId, company.Id, "6540", "Software expense", "expense", "USD", 0m, now.AddDays(-1)),
                new FinanceTransaction(fixture.TransactionId, company.Id, fixture.TransactionAccountId, vendor.Id, null, null,
                    now.AddHours(-1), "uncategorized", -250m, "USD", "Cloud software subscription", $"getright-{runId:N}",
                    createdUtc: DateTime.UtcNow),
                new FinanceInvoice(fixture.InvoiceId, company.Id, customer.Id, "INV-1042-A", now.AddDays(-1), now.AddDays(10), 1250m, "SEK", "awaiting_approval"),
                new FinanceInvoice(fixture.AlternateInvoiceId, company.Id, alternate.Id, "INV-1042-B", now.AddDays(-1), now.AddDays(11), 2500m, "SEK", "open"),
                new FinanceInvoice(fixture.ForeignInvoiceId, foreign.Id, foreignCustomer.Id, "INV-1042-A", now.AddDays(-1), now.AddDays(10), 987654.32m, "SEK", "awaiting_approval"));
            await db.SaveChangesAsync();
        });
        return fixture;
    }

    private static Company CreateCompany(Guid id, string name)
    {
        var company = new Company(id, name);
        company.UpdateWorkspaceProfile(name, null, null, "Europe/Stockholm", "SEK", "en", "SE");
        company.CompleteOnboarding(1, null, "{}");
        var seededUtc = DateTime.UtcNow;
        company.SetFinanceSeedStatus(FinanceSeedingState.Seeded, seededUtc, seededUtc);
        return company;
    }

    public Task<AgentReasoningResult?> GetRunAsync(Guid companyId, Guid agentId, Guid runId, CancellationToken cancellationToken) =>
        Task.FromResult<AgentReasoningResult?>(null);

    public Task<AgentReasoningResult> ReasonAsync(AgentReasoningRequest request, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var fixture = fixtures.Values.Where(item => item.IsValueCreated && item.Value.IsCompletedSuccessfully)
            .Select(item => item.Value.Result).SingleOrDefault(item => item.CompanyId == request.CompanyId && item.AgentId == request.AgentId);
        var source = request.Sources.FirstOrDefault(x => x.Type == "validated_finance_tool_result");
        if (fixture is null) return Task.FromResult(Unavailable(request));
        if (source is not null) return Task.FromResult(Synthesize(request, source));

        var (tool, action, arguments) = SelectTool(request.Instruction, fixture);
        if (!request.AllowedTools.Contains(tool, StringComparer.Ordinal)) return Task.FromResult(Unavailable(request));
        var step = new JsonObject
        {
            ["stepId"] = "finance",
            ["order"] = 1,
            ["dependencies"] = new JsonArray(),
            ["expectedAction"] = "Use the permitted Finance tool.",
            ["expectedEffect"] = "Return the result of the requested Finance action.",
            ["toolName"] = tool,
            ["toolVersion"] = "1.0.0",
            ["actionType"] = action,
            ["scope"] = "finance",
            ["arguments"] = arguments,
            ["evidenceRequirements"] = new JsonArray(),
            ["estimatedCost"] = 0m
        };
        return Task.FromResult(new AgentReasoningResult(Guid.NewGuid(), "completed", request.SchemaVersion,
            "Scripted Finance tool selection.", [], 1m, [], [], [], [],
            StructuredResult: new JsonObject
            {
                ["resultVersion"] = request.SchemaVersion, ["state"] = "ready", ["reasonCode"] = "proposed",
                ["safeExplanation"] = "A bounded Finance plan was prepared.", ["steps"] = new JsonArray(step)
            }));
    }

    private static (string Tool, string Action, JsonObject Arguments) SelectTool(string instruction, Fixture fixture)
    {
        if (instruction.Contains("cash balance", StringComparison.OrdinalIgnoreCase) ||
            instruction.Contains("kassasaldo", StringComparison.OrdinalIgnoreCase))
            return ("get_cash_balance", "read", new() { ["asOfUtc"] = AsOf.UtcDateTime.ToString("O") });
        if (instruction.Contains("recommend a category", StringComparison.OrdinalIgnoreCase))
            return ("recommend_transaction_category", "recommend", new()
            {
                ["transactionId"] = fixture.TransactionId.ToString(),
                ["candidateCategory"] = "software"
            });
        if (instruction.Contains("categorize the cloud software subscription", StringComparison.OrdinalIgnoreCase))
            return ("categorize_transaction", "execute", new()
            {
                ["transactionId"] = fixture.TransactionId.ToString(),
                ["category"] = "software"
            });
        return ("list_invoices_awaiting_approval", "read", new());
    }

    private static AgentReasoningResult Synthesize(AgentReasoningRequest request, AgentAiSource source)
    {
        var data = JsonNode.Parse(source.Snippet)?["data"];
        var swedish = request.Instruction.Contains("kassasaldo", StringComparison.OrdinalIgnoreCase);
        var summary = source.Title switch
        {
            "get_cash_balance" => string.Format(CultureInfo.GetCultureInfo(swedish ? "sv-SE" : "en-US"),
                swedish ? "Kassasaldo {0:N2} {1} vid {2}." : "Cash balance {0:N2} {1} as of {2}.",
                data?["amount"]?.GetValue<decimal>(), data?["currency"], data?["asOfUtc"]),
            "recommend_transaction_category" => $"Suggested category: {data?["recommendation"]?["recommendedCategory"]}. Review the recommendation for the cloud software subscription before applying it.",
            _ => $"Finance invoice evidence: {data?["invoices"]?.ToJsonString()}"
        };
        return new AgentReasoningResult(Guid.NewGuid(), "completed", request.SchemaVersion, summary,
            [new(summary, "fact", 1m, [source.Id])], 1m, [], [], [], [source.Id]);
    }

    private static AgentReasoningResult Unavailable(AgentReasoningRequest request) =>
        new(Guid.NewGuid(), "failed", request.SchemaVersion, "No scripted Finance response applies.", [], 0m, [], [], [], [],
            FailureCode: "provider_unavailable");

    private sealed record Fixture(Guid RunId, Guid CompanyId, Guid ForeignCompanyId, Guid AgentId, Guid RequesterId,
        Guid ApproverId, Guid CashAccountId, Guid TransactionAccountId, Guid TransactionId, Guid InvoiceId, Guid AlternateInvoiceId)
    {
        public Guid ForeignInvoiceId { get; } = Guid.NewGuid();
        public string RequesterSubject => $"{Requester}-{RunId:N}";
        public string ApproverSubject => $"{Approver}-{RunId:N}";
    }
}
