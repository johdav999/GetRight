# Architecture

## Planned configuration-driven integrations

[Roadmap milestones 5–10](roadmap.md#configuration-driven-integration-plan) propose
versioned JSON application manifests, declarative browser/API workflows and
trusted local build/launch recipes around the shared run/job lifecycle. Registered,
versioned extensions cover interactions and host infrastructure outside the shared
action vocabulary. Resolved non-secret definitions and execution versions become
part of immutable run attribution. General application manifests and configurable
host recipes remain planned. The current implementation uses fixed application
fixtures and host adapters, with a bounded browser vocabulary for approved cases.

## Current implementation

```mermaid
flowchart LR
    User[User] --> Dashboard[Blazor dashboard]
    Dashboard --> Store[(SQLite)]
    Worker[Local Node worker] -->|claim and complete over loopback| Dashboard
    Worker --> Browser[Playwright Chromium]
    Browser --> Fixture[Isolated Getright fixture]
    Browser --> WriterApp[Isolated WriterApp instance]
    Browser --> Company[Isolated Virtual Company UI and API]
    Worker --> Evidence[Local screenshots and trace]
    Dashboard --> Evidence
    Dashboard --> Task[Downloadable improvement task]
    Dashboard --> Job[Reviewed improvement job]
    Worker --> Codex[Codex SDK in a Git worktree]
    Codex --> Build[Commit and build changed application]
    Build --> WriterApp
```

`src/Getright.Dashboard` hosts interactive server-rendered pages and a small JSON
API. `RunStore` serializes mutations and uses SQLite WAL with parameterized SQL.
Before constructing RunStore, the process holds an exclusive-writer file handle
in its data directory. A second dashboard cannot perform restart recovery on a live
instance's leases, including when it attempts to bind a different port. The OS
releases ownership on process exit; retained metadata needs no manual deletion.
Schema version 6 retains runs, feedback, application profiles, improvement jobs,
events, heartbeat expiry, review audit and cleanup journals. Startup
migrates schemas 1–5 transactionally, preserving legacy payloads. Newer
schemas are rejected instead of being downgraded. Future changes require migrations.

Schema 5 adds suites, draft case definitions and generation proposals. Initial
suites reference existing catalogue IDs; generated cases have new stable IDs and
step IDs. Runs retain their frozen definition independently of suite membership.
The explicit OpenAI generation action produces a persisted, editable proposal;
only a separate apply action appends draft cases atomically. Generated text cannot
enable an adapter. Server-side generation is bounded, uses a strict Responses JSON
schema and handles refusal/truncation/failure without adding cases. Only the feature,
suite name and application name are sent. The key stays in server configuration.
See [test suites](test-suites.md) for the boundary and contracts.

Schema 6 adds test-implementation jobs/events and verified workflow bindings. An
explicit approval freezes the case definition digest and clean application source
receipt. Approval does not depend on the original manual-review host remaining
online. Codex writes one bounded JSON artifact in a separate Getright worktree;
source-only planning checks fixture prerequisites before any application build.
Unsupported cases retain an actionable blocked explanation without starting a host.
Planning shares the same leases, cancellation, active-work counts and recovery.
Missing capabilities end in `blocked`, independently of execution failures. Queue
and retry check prior blockers against the current definition digest, clean
application source and installed workflow-engine digest before any paid work.
Unchanged blockers stay disabled, including blockers hidden by later cancelled
attempts. Legacy blocked failures retain their original rows and use their recorded
worker summary for engine provenance. Changing only runtime metadata cannot add
fixture capabilities. Source/engine changes permit fresh review and validation;
they never enable the case automatically.
The worker retains its base and resulting local commit. Fixed host adapters build
the approved application revision in a separate worktree. Two validation runs
must pass with distinct fixtures/resources on the verified fresh runtime before a
binding is atomically enabled.
The continuous worker can claim a bounded FIFO batch of up to ten cases with the
same approved application revision. Each owns a private renewable lease and its
own test-plan worktree/commit. It prepares all plans before grouping successful
cases by source/SDK/build-recipe identity and compiling once per compatible group.
The retained build inventory covers binaries, dependencies and source-mapped
static assets; its digest and owner link are immutable job attribution. Every
case uses a fresh sequential host/data root and two independent proof runs.
Cancellation and errors remain per case; the shared compiler stops when no case
still needs it. No persistent build cache or automatic artifact deletion exists.
The binding freezes the raw plan digest, execution-engine digest, application
source commit and proof runs. Normal queues require that source revision and a
worker with the verified engine. Neither approval nor verification accepts an
application run. See [test implementation](test-implementation.md).

`config/catalog.json` is copied into the dashboard build and published output.
Rebuild after editing it. Test definitions are snapped into queued runs, so later
catalogue edits cannot change historical reproduction steps. The server and
worker allowlist executable adapters; simply changing a draft flag cannot make
an unimplemented test execute.

`worker/src/index.mjs` claims and runs one job at a time. It has no inbound HTTP
listener or shell-command endpoint. Codex proposes bounded declarative browser
actions during explicit implementation; normal runs interpret the verified plan
without a model call. The demo and fixture setup use trusted source code.
A fresh browser context isolates each run.
Step screenshots and a Playwright trace are written to the shared evidence root
before completion is submitted. Failed launches and browser failures report a
failed run; they do not manufacture passing steps or human acceptance.

`worker/src/launch.mjs` supervises the worker child. A startup source/dependency
stamp is checked before each queue claim; changed source makes the idle child
request a reload instead of continuing with cached modules. The supervisor only
restarts that explicit reload exit, not ordinary failures. Active jobs finish first;
retained reviews close on source reload without holding the queue indefinitely.
Supervisor loss stops its child and owned operations.

Normal dashboard restart refuses queued/active work. An explicit `-PreserveQueued`
upgrade, with workers stopped, allows a complete inventory of unclaimed
standalone tests and test-implementation jobs to survive a reload. Executing work and other
work still block it. This avoids making an old worker's unclaimed queue prevent
the dashboard/worker upgrade required to service it.

The Virtual Company PowerShell launcher first calls the guarded dashboard launcher
in background mode. It reuses a healthy matching instance or starts a stopped
dashboard, refusing unrelated listeners and data-directory mismatches before
application setup. The Node launcher's dashboard health check also reports an
actionable startup error before configuration, worktree creation or compilation.

For standalone runs, `run-sessions.mjs` forks an owned `run-child.mjs` process.
The claim and bounded configuration cross private IPC, never command-line arguments.
Tracing stops and the dashboard acknowledges the terminal result before manual
review begins. A review-ready message releases the execution queue while that
child retains its browser and transport. One test/job executes at a time; completed
reviews are separate processes and cannot consume execution leases. Review has no active run
lease or automation deadline; manual actions cannot change the stored result,
evidence or acceptance. Headless runs, explicit auto-close mode and job-owned
regressions close their browsers automatically. Job hosts retain their existing
bounded lifecycle. A worker retains at most three completed reviews, closing the
oldest browser when a fourth completes. Finish review, capacity, worker stop and
source reload affect live browsers only. Private owner heartbeats supplement IPC
disconnect detection; abandoned run children close their browsers after owner loss.
Each child's logs and diagnostic process identity stay under `data/run-workers/`.
Crashes before completion are reported interrupted when the parent is available,
or recover through the ordinary run lease. `--once` waits for its review before exit.

Control-room **Run UAT test** and **Run again** instead request a docked run.
The worker streams its actual headless Chromium session to the dashboard through
outbound loopback requests, without a browser debugging port. Input is refused
while automated actions execute. Once tracing stops and terminal completion is acknowledged,
bounded input commands operate the same page for manual review. Docked sessions
remain open even in headless mode unless auto-close is explicit. **Finish review**
closes only that review browser; hiding or undocking the viewer
does not close it. Frames, input queues and private session credentials are
ephemeral and separate from immutable evidence. See [live browser docking](live-browser.md).

Worker presence uses private ephemeral renewal tokens and four-second heartbeats.
The public control-room status combines presence with authoritative queue counts,
active stored runs/jobs and live step progress. It marks presence offline after
15 seconds and lists retained reviews separately. Presence cannot claim work,
change results or grant acceptance; missing telemetry never stops execution.

Optional step-by-step execution freezes its mode on a standalone docked run and
requires a step-capable worker claim. The same trusted runner pauses before each
catalogued step, accepts an exact-step release, runs its actions/assertions and
captures ordinary evidence before moving on. Server ordering prevents duplicate
or stale UI requests from skipping steps. App input is available at pauses with
a capable worker, and locks immediately on advance. Accepted input drains through
acknowledged batches before automation resumes; worker input and release use the
same serial lane. Commands target the exact paused step, so stale tabs cannot
inject input into later steps. Requested manual interaction marks those steps as
assisted in the stored run and feedback prompt; active tracing includes the actions.
Human waits retain lease heartbeats, suspend only the active execution deadline,
and have a separate 15-minute bound; cancellation/shutdown/recovery still apply.
Implementation proofs and improvement-job regressions remain automatic. Engine
attribution includes the deadline-supervision source as well as the runner.

The running dashboard's assembly informational version identifies the demo build.
.NET includes the source revision when building from a committed Git checkout.
This identifies the local fixture. The WriterApp launcher supplies a unique
assembly version and retains a source receipt; preflight checks its actual version
endpoint and development identity. Runs freeze that profile, and the worker checks
it again before creating data and after the workflow. Passing completions must
match the frozen target/build/account and include the created resource identity.
The source receipt records if the source was dirty; a commit hash alone does not
identify those uncommitted changes. The milestone 2 worker builds clean source in
a new worktree, commits its change, assigns a job-specific assembly version and
verifies the actual runtime before rerunning the original test. Build changes to
tracked source fail attribution checks.

## Data and state

```text
data/
  getright.db             # runs, feedback, profiles, jobs, suites, proposals and bindings, schema version 6
  keys/                   # local ASP.NET keys, protected with DPAPI on Windows
  evidence/<run-id>/
    open.png
    edit.png
    save.png
    reopen.png
    trace.zip
  writerapp/<instance-id>/ # isolated WriterApp database, config and build receipt
  jobs/<job-id>/          # bounded logs, diff, summary and changed host data
  case-implementations/<job-id>/ # bounded logs, workflow copy, summary and validation host data
```

Automated state: `queued → running → passed | failed | cancelled | interrupted`.

Acceptance state: `pending | accepted | improvements-requested`.

Review decisions apply only to completed runs. Adding feedback marks that run as
improvements requested in the same transaction as feedback persistence. Reviews
can be changed; test results, test snapshots and existing feedback are retained.
Each new run starts pending. Review and feedback-induced decision changes append
transactional audit events. History is paginated; Home displays the latest 12 runs
per test. Metadata remains in SQLite after explicitly selected evidence cleanup.

Review panels show the saved acceptance beside their controls and confirm saves
before the feedback form. The current decision's action is disabled. Repeating
the same decision through another tab or API is idempotent and adds no audit row;
explicit decision changes still append history. Prior duplicate history is retained.

The control room places a quick-review panel above Workflow detail. Its actions
reuse the same review, feedback and improvement-job store methods as full review.
The default **Run & review** view keeps case generation out of this workspace.
Its **Test case generation** view contains progress, bulk approval and the
selected case's implementation/retry controls. Switching views retains the case,
suite/application filters and mounted review form, including unsaved comments.
The generation view is directly addressable with `?view=generation`.
The displayed run ID is pinned while newer runs arrive; switching is explicit and
clears unsaved comment fields. Step choices come from that run's frozen snapshot.
Inline task edits retain their revision and require reload on concurrent edits;
preparing a task never starts implementation. Only Implement improvement queues it.

Claims use a private lease that is never returned by ordinary run reads. Duplicate
claims, mismatched leases, duplicate completions and incomplete passing results
are rejected. Dashboard restart invalidates running leases. Run, job and cleanup leases expire after 45 seconds and renew every five seconds.
A background monitor recovers expired leases. Standalone runs have a bounded
deadline and cancel their browsers on shutdown, cancellation or lost ownership.

## Trust boundary

This is a **single trusted local user's development tool**. The server validates
loopback peers, loopback Host headers and same-origin browser requests, including
WebSocket origins. The worker accepts only a loopback HTTP dashboard origin.
Evidence routes serve only files referenced by that run. Files are not exposed as
a general static directory. No arbitrary command, repository path or script can
be submitted through the API.

Local processes with access to the dashboard and data directory are trusted. The
lease is a concurrency control, not user authentication. The application is not
suitable for LAN access, reverse-proxy publishing or multi-user hosting without
authentication, authorization, CSRF/session design and authenticated worker leases.

Evidence and traces can contain application content and session data. Keep them
in ignored local storage, use dedicated UAT accounts, and sanitize any exported
material before sharing. GitHub Actions runs the isolated demo and synthetic job
contracts; live Codex/WriterApp validation is opt-in and its evidence is not uploaded.

## Codex job execution

Feedback can create a revisioned draft; the explicit Implement action queues it.
The worker uses the [official Codex SDK](https://learn.chatgpt.com/docs/codex-sdk)
with the existing local sign-in, workspace-write permissions, disabled command
network access and no automatic escalation. Task text is not a command template.
Repository selection and the application build/launch adapters come from trusted
local configuration and fixed worker source.

The worker validates the original clean source revision, creates a short dedicated
worktree outside the original checkout, streams Codex events, commits its source
diff locally and runs bounded build/launch commands. A changed app gets a fresh
database and is stopped after its regression test. Worktrees, branches, evidence
and logs are retained for review. No merge, deployment or publish step exists.

Rerun creation and its job link are saved atomically, using the original frozen
test definition. The runtime version, resulting source commit and verified account
must match the rerun target. Automated success moves the job to awaiting-review;
it never accepts the application change on the user's behalf.

Job leases last 45 seconds and are renewed every five seconds. Cancellation aborts
owned operations; shutdown, restart and lost leases retain an interrupted job.
Any owned in-flight regression run becomes interrupted and rejects stale completion.
Standalone UAT and cleanup tasks also use renewable leases. See
[improvement jobs](improvement-jobs.md) for the lifecycle and validation scope.

Virtual Company uses the same run/job contract with optional company and role fields.
Its Getright-owned host composes the actual API through the repository test factory
and a fresh in-memory SQLite database, with a real Blazor Web UI. A local gateway
checks the owned Web binary and forwards Blazor WebSockets. See
[Virtual Company UAT](virtual-company-uat.md) for runtime attribution and limits.

[Local operations](operations.md) describes paginated review, comparisons, child
process ownership, explicit retention and Git worktree cleanup boundaries.
