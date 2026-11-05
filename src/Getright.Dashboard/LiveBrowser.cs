using System.Security.Cryptography;
using System.Text;

namespace Getright.Dashboard;

public record BrowserConnect(string Lease, int Width, int Height, bool SupportsPausedInput = false);
public record BrowserWorker(string Token, string? Phase = null, long? AcknowledgedBatch = null);
public record BrowserFrame(string Token, string Jpeg);
public record BrowserStep(string Token, string StepId, string Stage);
public record BrowserAdvance(string StepId, bool RunRemaining = false);
public record BrowserStepProgress(int StepIndex, string Stage, bool AwaitingAdvance);
public record BrowserInput(string Type, double? X = null, double? Y = null, double? DeltaX = null, double? DeltaY = null,
    string? Text = null, string? Key = null, string[]? Modifiers = null, int ClickCount = 1, string? StepId = null);

public sealed partial class RunStore
{
    public void RecordPausedInput(string id, string stepId)
    {
        lock (gate)
        {
            var run = Get(id);
            if (!run.StepByStep || run.Status != "running" || run.CancelRequested || !run.TestSnapshot.Steps.Any(s => s.Id == stepId))
                throw new ArgumentException("This run is no longer available for paused interaction.");
            if (run.AssistedSteps?.Contains(stepId) == true) return;
            using var db = Open(); using var cmd = db.CreateCommand();
            cmd.CommandText = "UPDATE runs SET payload=$payload WHERE id=$id";
            cmd.Parameters.AddWithValue("$id", id);
            cmd.Parameters.AddWithValue("$payload", System.Text.Json.JsonSerializer.Serialize(run with { AssistedSteps = [.. run.AssistedSteps ?? [], stepId] }, AppJson.Options));
            cmd.ExecuteNonQuery(); // Preserve the active lease and its expiry.
        }
    }
    public UatRun RequireDockedRunLease(string id, string lease)
    {
        lock (gate)
        {
            var run = RequireRunLease(id, lease);
            if (!run.Docked || run.ImprovementJobId is not null || run.CaseImplementationJobId is not null)
                throw new ArgumentException("Only a requested standalone docked run can attach a live browser.");
            return run;
        }
    }
}

// Ephemeral browser transport is separate from immutable run evidence. The worker
// makes outbound loopback calls; no browser debugging port is exposed. Private
// session credentials never appear in public status, frames, storage or logs.
public sealed class LiveBrowser(RunStore store)
{
    private sealed class Session(string token, int width, int height, bool supportsPausedInput)
    {
        public string Token { get; } = token;
        public int Width { get; } = width;
        public int Height { get; } = height;
        public string Phase { get; set; } = "automating";
        public string? ClosedReason { get; set; }
        public byte[]? Frame { get; set; }
        public long Sequence { get; set; }
        public DateTimeOffset LastSeen { get; set; } = DateTimeOffset.UtcNow;
        public DateTimeOffset? LastFrame { get; set; }
        public Queue<BrowserInput> Commands { get; } = new();
        public int StepIndex { get; set; } = -1;
        public string StepStage { get; set; } = "preparing";
        public bool AdvanceRequested { get; set; }
        public bool RunRemaining { get; set; }
        public bool SupportsPausedInput { get; } = supportsPausedInput;
        public List<BrowserInput>? InFlight { get; set; }
        public long InputBatch { get; set; }
    }
    private readonly object gate = new();
    private readonly Dictionary<string, Session> sessions = [];
    private static bool Terminal(string status) => status is "passed" or "failed";
    private static bool AwaitingAdvance(Session session) => session.Phase == "automating" &&
        session.StepStage == "waiting" && !session.AdvanceRequested && !session.RunRemaining;
    private static bool Paused(UatRun run, Session session) => session.SupportsPausedInput && run.StepByStep &&
        run.Status == "running" && !run.CancelRequested && AwaitingAdvance(session);
    private static void Expire(Session session)
    {
        if (session.Phase is not ("closed" or "disconnected") && DateTimeOffset.UtcNow - session.LastSeen > TimeSpan.FromSeconds(30))
        { session.Phase = "disconnected"; session.Commands.Clear(); }
    }
    public object Connect(string id, BrowserConnect request)
    {
        _ = store.RequireDockedRunLease(id, request.Lease);
        if (request.Width is < 320 or > 1920 || request.Height is < 240 or > 1440) throw new ArgumentException("Invalid browser viewport.");
        lock (gate)
        {
            foreach (var item in sessions.Values) Expire(item);
            if (sessions.TryGetValue(id, out var previous) && previous.Phase is not ("closed" or "disconnected")) throw new ArgumentException("This run already owns a live browser.");
            foreach (var key in sessions.Where(p => p.Value.Phase is "closed" or "disconnected").OrderBy(p => p.Value.LastSeen).Select(p => p.Key).ToArray())
                if (sessions.Count >= 32) sessions.Remove(key);
            if (sessions.Count >= 32) throw new ArgumentException("Too many live review sessions. Finish an existing review first.");
            var session = new Session(Guid.NewGuid().ToString("N"), request.Width, request.Height, request.SupportsPausedInput);
            sessions[id] = session; return new { token = session.Token };
        }
    }
    private Session Require(string id, string token)
    {
        if (!sessions.TryGetValue(id, out var session) || token is null || token.Length != 32 ||
            !CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(token), Encoding.UTF8.GetBytes(session.Token)))
            throw new ArgumentException("The live browser session is no longer owned by this worker.");
        Expire(session); return session;
    }
    public void Frame(string id, BrowserFrame request)
    {
        if (request.Jpeg is null || request.Jpeg.Length is < 4 or > 240000) throw new ArgumentException("Live frame is too large.");
        byte[] bytes;
        try { bytes = Convert.FromBase64String(request.Jpeg); } catch (FormatException) { throw new ArgumentException("Invalid live frame."); }
        if (bytes.Length is < 4 or > 180000 || bytes[0] != 0xff || bytes[1] != 0xd8 || bytes[^2] != 0xff || bytes[^1] != 0xd9) throw new ArgumentException("Use a bounded JPEG frame.");
        lock (gate)
        {
            var session = Require(id, request.Token);
            if (session.Phase is "closed" or "disconnected") return;
            session.Frame = bytes; session.Sequence++; session.LastFrame = DateTimeOffset.UtcNow;
        }
    }
    public object Poll(string id, BrowserWorker request)
    {
        var run = store.Get(id);
        lock (gate)
        {
            var session = Require(id, request.Token);
            if (run.Status is "cancelled" or "interrupted") session.Phase = "closed";
            if (request.Phase == "review" && session.Phase == "automating")
            {
                if (!Terminal(run.Status)) throw new ArgumentException("Manual input is unavailable until automation is complete.");
                session.Phase = "review";
            }
            else if (request.Phase is not (null or "review")) throw new ArgumentException("Invalid live browser phase.");
            session.LastSeen = DateTimeOffset.UtcNow;
            if (request.AcknowledgedBatch == session.InputBatch) session.InFlight = null;
            var commands = new List<BrowserInput>();
            // An advance locks new input immediately, but already accepted input
            // must finish and be acknowledged before the step can execute.
            if ((session.Phase == "review" && Terminal(run.Status)) ||
                (session.SupportsPausedInput && run.Status == "running" && !run.CancelRequested && session.Phase == "automating" && session.StepStage == "waiting"))
            {
                if (session.InFlight is null)
                {
                    while (commands.Count < 8 && session.Commands.TryDequeue(out var command)) commands.Add(command);
                    if (commands.Count > 0 && session.SupportsPausedInput) { session.InFlight = commands; session.InputBatch++; }
                }
                else commands = session.InFlight;
            }
            else { session.Commands.Clear(); session.InFlight = null; }
            return new { phase = session.Phase, commands, inputBatch = session.InputBatch };
        }
    }
    public void End(string id, BrowserWorker request)
    { lock (gate) { var session = Require(id, request.Token); session.Phase = "closed"; session.Commands.Clear(); } }
    public List<string> ReviewRunIds()
    {
        lock (gate) { foreach (var session in sessions.Values) Expire(session); return sessions.Where(p => p.Value.Phase == "review").Select(p => p.Key).ToList(); }
    }
    public object Status(string id)
    {
        var run = store.Get(id);
        lock (gate)
        {
            sessions.TryGetValue(id, out var session); if (session is not null) Expire(session);
            if (session is not null && run.Status is "cancelled" or "interrupted") { session.Phase = "closed"; session.Commands.Clear(); }
            var phase = session?.Phase ?? (run.Status is "queued" or "running" ? "waiting" : "unavailable");
            var earlierReview = sessions.FirstOrDefault(p => p.Key != id && p.Value.Phase == "review");
            var step = session is { StepIndex: >= 0 } && session.StepIndex < run.TestSnapshot.Steps.Count ? run.TestSnapshot.Steps[session.StepIndex] : null;
            return new { runId = id, phase, runStatus = run.Status, run.Acceptance, sequence = session?.Sequence ?? 0,
                width = session?.Width ?? 1440, height = session?.Height ?? 1000, lastFrameAt = session?.LastFrame,
                earlierReviewRunId = earlierReview.Key, closedReason = session?.ClosedReason,
                run.StepByStep, run.CancelRequested, stepId = step?.Id, stepTitle = step?.Title, stepNumber = (session?.StepIndex ?? -1) + 1,
                stepCount = run.TestSnapshot.Steps.Count, stepStage = session?.StepStage ?? "preparing",
                runRemaining = session?.RunRemaining ?? false,
                canAdvance = run.StepByStep && run.Status == "running" && !run.CancelRequested && session is not null && AwaitingAdvance(session),
                assistedSteps = run.AssistedSteps ?? [],
                canControl = (phase == "review" && Terminal(run.Status)) || (session is not null && Paused(run, session)) };
        }
    }
    public byte[]? Image(string id)
    { _ = store.Get(id); lock (gate) { return sessions.GetValueOrDefault(id)?.Frame; } }
    public BrowserStepProgress? StepProgress(string id)
    {
        lock (gate)
        {
            if (!sessions.TryGetValue(id, out var session)) return null;
            Expire(session);
            return session.Phase == "automating" && session.StepIndex >= 0
                ? new(session.StepIndex, session.StepStage, AwaitingAdvance(session)) : null;
        }
    }
    public object Step(string id, BrowserStep request)
    {
        var run = store.Get(id);
        if (!run.StepByStep || run.Status != "running" || run.CancelRequested) throw new ArgumentException("This run is not available for step execution.");
        var index = run.TestSnapshot.Steps.FindIndex(s => s.Id == request.StepId);
        if (index < 0) throw new ArgumentException("Unknown frozen test step.");
        lock (gate)
        {
            var session = Require(id, request.Token);
            if (session.Phase != "automating") throw new ArgumentException("The browser is no longer automating this run.");
            if (request.Stage == "waiting")
            {
                if (index == session.StepIndex + 1 && (session.StepIndex == -1 || session.StepStage == "passed"))
                { session.StepIndex = index; session.StepStage = "waiting"; }
                else if (index != session.StepIndex || session.StepStage is not ("waiting" or "running"))
                    throw new ArgumentException("Steps must execute once in their frozen order.");
                if (session.StepStage == "waiting" && (session.AdvanceRequested || session.RunRemaining) && session.Commands.Count == 0 && session.InFlight is null)
                { session.AdvanceRequested = false; session.StepStage = "running"; }
            }
            else if (request.Stage == "passed")
            {
                if (index != session.StepIndex || session.StepStage is not ("running" or "passed"))
                    throw new ArgumentException("Only the running step can complete.");
                session.StepStage = "passed";
            }
            else throw new ArgumentException("Invalid step execution stage.");
            return new { execute = session.StepStage == "running" };
        }
    }
    public void Advance(string id, BrowserAdvance request)
    {
        var run = store.Get(id);
        if (!run.StepByStep || run.Status != "running" || run.CancelRequested) throw new ArgumentException("This run is not paused for step execution.");
        lock (gate)
        {
            if (!sessions.TryGetValue(id, out var session)) throw new ArgumentException("The step browser is unavailable.");
            Expire(session);
            if (session.Phase != "automating" || session.StepStage != "waiting" || session.StepIndex < 0 ||
                run.TestSnapshot.Steps[session.StepIndex].Id != request.StepId)
                throw new ArgumentException("The displayed step changed. Wait for its current state before continuing.");
            // Repeated clicks target this exact step; they cannot grant later steps.
            session.AdvanceRequested = true;
            session.RunRemaining |= request.RunRemaining;
        }
    }
    public void Input(string id, BrowserInput input)
    {
        var run = store.Get(id);
        ValidateInput(input);
        lock (gate)
        {
            if (!sessions.TryGetValue(id, out var session)) throw new ArgumentException("The browser session is unavailable.");
            Expire(session);
            var paused = Paused(run, session);
            if (!(session.Phase == "review" && Terminal(run.Status)) && !paused)
                throw new ArgumentException("Input is available only while a step is paused or after automation completes.");
            if (paused && (session.StepIndex < 0 || input.StepId != run.TestSnapshot.Steps[session.StepIndex].Id))
                throw new ArgumentException("The displayed step changed. Wait for its current state before interacting.");
            if (!paused && input.StepId is not null) throw new ArgumentException("That paused step has finished. Reload its current browser state before interacting.");
            if (session.Commands.Count >= 64) throw new ArgumentException("The browser input queue is full. Wait before trying again.");
            if (paused) store.RecordPausedInput(id, input.StepId!);
            session.Commands.Enqueue(input);
        }
    }
    public void Close(string id, string? reason = null)
    {
        var run = store.Get(id);
        if (!Terminal(run.Status)) throw new ArgumentException("Hide the panel or cancel the run while automation is active.");
        if (reason is not (null or "finished" or "capacity" or "worker-stopped" or "worker-updated")) throw new ArgumentException("Invalid review close reason.");
        lock (gate) { if (sessions.TryGetValue(id, out var session)) { session.Phase = "closed"; session.ClosedReason = reason ?? "finished"; session.Commands.Clear(); } }
    }
    private static void ValidateInput(BrowserInput input)
    {
        static bool Position(double? value) => value is { } number && double.IsFinite(number) && number is >= 0 and <= 1;
        if (input.Type is "click" or "wheel")
        {
            if (!Position(input.X) || !Position(input.Y) || input.ClickCount is < 1 or > 2) throw new ArgumentException("Invalid browser coordinates.");
            if (input.Type == "wheel" && (input.DeltaX is not { } dx || input.DeltaY is not { } dy || !double.IsFinite(dx) || !double.IsFinite(dy) || Math.Abs(dx) > 2000 || Math.Abs(dy) > 2000)) throw new ArgumentException("Invalid scroll delta.");
        }
        else if (input.Type == "text") { if (input.Text is null || input.Text.Length is < 1 or > 4000) throw new ArgumentException("Enter up to 4000 characters."); }
        else if (input.Type == "key")
        {
            if (input.Key is not ("Enter" or "Tab" or "Escape" or "Backspace" or "Delete" or "ArrowUp" or "ArrowDown" or "ArrowLeft" or "ArrowRight" or "Home" or "End" or "PageUp" or "PageDown" or "a" or "c" or "x" or "z" or "y") ||
                (input.Modifiers ?? []).Any(m => m is not ("Control" or "Meta" or "Alt" or "Shift")) || (input.Modifiers?.Length ?? 0) > 4) throw new ArgumentException("Unsupported browser key.");
        }
        else if (input.Type is not ("reload" or "back" or "forward")) throw new ArgumentException("Unsupported browser command.");
    }
}
