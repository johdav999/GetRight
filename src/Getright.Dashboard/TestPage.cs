using System.Net;

namespace Getright.Dashboard;

public static class TestPage
{
    public static async Task<IResult> Open(string id, ApplicationSetup setup, HttpContext context)
    {
        context.Response.Headers.CacheControl = "no-store";
        try { return Results.Redirect(await setup.TestPage(id, context.RequestAborted)); }
        catch (ArgumentException error)
        {
            return Results.Content($$"""
                <!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Open test page · Getright</title><link rel="stylesheet" href="/app.css"></head>
                <body class="fixture-body"><main class="fixture-card"><p class="eyebrow">GETRIGHT · MANUAL REVIEW</p><h1>Test page unavailable</h1><p role="alert">{{WebUtility.HtmlEncode(error.Message)}}</p><p>Start the isolated application launcher and check its setup, then try again.</p><p><a href="/applications">Application setup</a> · <a href="/">Return to test control room</a></p></main></body></html>
                """, "text/html", statusCode: 400);
        }
    }
}
