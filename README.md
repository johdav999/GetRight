# Getright

A local UAT control room for **WriterApp** and **Virtual Company**.

Choose a test → run it → review evidence → describe an improvement → prepare a
Codex task → implement and rerun. Automated results and human acceptance stay
separate throughout the cycle.

Repository: [johdav999/GetRight](https://github.com/johdav999/GetRight).

## Implementation status

This repository includes the foundation, the first WriterApp workflow, Virtual
Company test-company setup, and the feedback-to-fix and operational milestones.
It includes:

- A .NET 10 Blazor dashboard with application filters, readable test steps and run history.
- SQLite persistence for test snapshots, results, review decisions and feedback.
- A local Node.js / Playwright worker with a live docked browser for control-room runs.
- An isolated demo test that creates, saves and reopens a note, capturing step
  screenshots, a trace, fixture identity and the running assembly version.
- Step-specific feedback, task previews and downloadable implementation prompts.
- WriterApp application setup, runtime build/account checks, and a create/save/reopen
  adapter against an actual isolated WriterApp instance.
- Four remaining draft WriterApp tests; Virtual Company creation and draft-permission UAT.
- Explicit draft-case approval, Codex-generated bounded workflows, two isolated
  validation runs and verified automation bindings.
- Editable Codex jobs, isolated worktrees/commits, streamed progress, bounded build
  and launch logs, runtime version checks, linked reruns and before/after evidence.
- Run/job cancellation, heartbeat leases, bounded execution and restart recovery.
- Review audit history, paginated history, run comparison and explicit evidence/worktree cleanup.
- Build checks, a browser/API smoke check, GitHub Actions and an issue template.

**Not implemented yet:** the remaining WriterApp adapters and external/multi-user login.
Cleanup is explicitly selected and confirmed; automatic scheduled purges are not
enabled. See the [implementation roadmap](docs/roadmap.md).
Draft tests stay disabled until their automation is implemented and verified.
Codex starts only after an explicit implementation action.

Milestones 5–10 plan configuration-driven application integrations: versioned
manifests, declarative workflows, trusted build recipes and dashboard setup,
followed by migration and a third-application proof. The draft implementation flow
already supports bounded browser workflows for the three existing fixture adapters;
general application manifests and configurable host recipes remain planned.

## Requirements

- .NET SDK 10.0.400, matching global.json and the CI build.
- Node.js 24 or later, with npm.
- Playwright Chromium, installed by the command below.
- Windows PowerShell for the convenience scripts. The underlying .NET and Node
  commands are portable; this starter is currently validated on Windows.

## First run

From the repository root:

```powershell
npm ci --prefix worker
npm run browsers --prefix worker
.\scripts\start-dashboard.ps1
```

Starting again reuses the healthy dashboard and prints its URL. To rebuild/reload
an idle instance, use `./scripts/start-dashboard.ps1 -Restart`. Use `-Background`
to run without keeping a terminal open, then `./scripts/stop-dashboard.ps1` to stop
it. Restart/stop refuse queued or running work and verify the exact dashboard
process before stopping it. `-Url http://127.0.0.1:<port>` selects another loopback
origin. Each simultaneously running dashboard needs its own data directory.

In another terminal, also at the repository root:

```powershell
.\scripts\start-worker.ps1
```

The launcher reloads changed worker source or locked dependencies at the next idle
queue boundary, after executing work finishes. Reload closes retained review browsers
while preserving their saved results. It never retries
failed jobs automatically. `-Background` runs a hidden worker and prints its PID
and log directory under `data/worker-hosts/`.
An unsuccessful test implementation prints its recorded reason and details URL.
Missing fixture/application prerequisites must be corrected before retrying;
reinstalling Chromium only addresses a missing browser installation.

For a dashboard upgrade with unclaimed tests or test-implementation jobs, stop the
workers first, then use `./scripts/start-dashboard.ps1 -Restart -PreserveQueued
-Background`. This explicit path preserves queued implementations and history;
it refuses executing tests/implementations, other active work or an incomplete queue
inventory. Start the worker again after the dashboard is ready.

Open [Getright on this computer](http://127.0.0.1:5120). Select **Run UAT test** on
the Getright demo. Getright opens a dedicated run page with the actual worker browser
beside the case instructions and human acceptance. The demo performs four repeatable
steps and reports the result. Open **Run details & evidence** to inspect screenshots
and download the trace. Accept the run, or choose a step and create an improvement
task. Installing Chromium with `npm run browsers`
does not start the worker.

The dock shows the actual test session: watch while automation runs, then click,
type and scroll in that same session after its result and evidence are saved.
Its controls and detailed messages start collapsed under **Controls & status**.
A compact status and the next-step action stay visible, giving the app
most of the dock's height. Expand the drawer for navigation, extra step actions,
full step instructions and Finish review. Click the app to type or paste directly.
Completed reviews run independently: the worker can pick up the next test or job
as soon as automation finishes. Use **Finish review** to close just that browser.
Returning to the control room keeps the session alive. Resume it from
**Worker activity** or **Watch test / continue review** in run details.
**Undock** opens a standalone viewer of the same session without losing navigation
or unsaved state. On narrow screens the tested app stacks above the case and review.
**Worker activity** shows executing work, paused steps, queued counts
and open reviews, with direct links and **Finish review** buttons. A step pause
still occupies execution until you continue, cancel or reach its 15-minute bound.
Each worker retains the three newest completed reviews; opening a fourth closes
the oldest browser with a visible reason, without changing its saved evidence.

Manual interaction is outside the recorded run and never changes its result,
evidence or acceptance. The live session is temporary: stopping its worker or
restarting the dashboard ends it; stored results remain available. Docked runs use
a headless Chromium browser even with the worker's normal visible-browser setting.
Use `./scripts/start-worker.ps1 -AutoClose` for unattended runs. Legacy API runs
without docking retain their visible window independently until it closes; non-docked headless
runs and implementation-job regressions close automatically.
See [live browser docking](docs/live-browser.md) for the transport and lifecycle.

Choose **Execution mode → Step through one at a time** before starting a test to
pause before each catalogued step. Use **Run next step** in the live dock to
execute that step and capture its evidence, or **Run remaining steps** to finish
automatically in the same browser. The default **Run all steps automatically**
keeps the existing behavior. **Run again** also lets you choose either mode.
Fixture setup runs before the first pause. Click and type into the app while
paused; input locks while a step executes. Manual interaction marks the run as
assisted and is included in its trace. **Run next step** executes the automated
actions and assertions; stepping does not accept individual steps or the run.
Pauses have a 15-minute limit, keep the worker lease alive, and do not consume
the normal automation time budget. Use **Cancel test** to stop a paused run.

Each runnable case also has **Open test page**. It opens the configured running
application's entry page in a left panel occupying half the window after checking
the build and UAT identity. **Undock** opens the entry page in a standalone tab
and closes the panel; save in-app changes first, since unsaved state and navigation
are not transferred. **Close** restores the full dashboard. On narrow screens the
panel stacks above the dashboard. Apps that block embedding can use **Undock**.
It needs no worker and creates no run or acceptance decision. Keep the isolated
application launcher running while reviewing. This opens the configured build;
it does not build or relaunch a stopped improvement-job instance.

The right panel starts with **Review latest run**, above Workflow detail. Accept
or request improvements, choose a test step, and create an improvement task from
your comment and requested outcome. Preview/download the prompt or prepare, edit
and explicitly implement its Codex job in the same panel. If a newer run arrives,
the displayed review and unsaved comment stay attached to their original run;
select **Review latest run** to switch. Automation never accepts a run for you.

## Test suites and generated cases

Use **Test suite** in the control room to select a group of related cases. The
initial suites contain the existing Getright, WriterApp and Virtual Company cases;
their IDs and historical runs are preserved. Open **Manage suites & generate
cases** (or **Test suites** in the sidebar) to create suites and choose existing
cases for them.

On the suite page, describe a feature, choose 1–10 cases, and select **Generate test
cases**. OpenAI returns proposals with preconditions, actions, expected results and
human review questions. Edit them, select the cases to keep, and choose **Add
selected draft cases to suite**. Generation alone does not add cases. The original
proposal and model/response identity are retained separately from edited cases.
Added cases start as drafts with automation and open-page actions disabled.

To make a draft runnable, select **Review draft** on its card. Above Workflow
detail, choose **Approve and implement test case**. Start or restart the local
worker with `./scripts/start-worker.ps1` so it loads implementation support. Codex
creates a bounded workflow in a dedicated Git worktree; the worker commits it
locally and validates every frozen step twice with fresh fixtures. Only two passing
validations enable **Run UAT test** and **Open test page**. Human acceptance of
application runs remains pending.

Approval validates the isolated, clean source receipt without contacting its old
manual-review instance. The continuous worker prepares up to ten compatible queued
case plans, builds their common application revision once, then validates each
case in a fresh isolated host with its own data. Each case still needs two passing
proof runs. Different source revisions/SDKs/build recipes use separate builds;
new arrivals form the next batch. Progress/details identify the shared build and
its compiler log. `-Once` retains single-case execution.
Running a verified test or opening its manual test page still checks the configured
running application's build and identity. Missing/dirty source receipts are rejected.
New implementation builds require 5 GiB available on both their worktree and data
volumes (256 MiB for the demo); low space fails before creating a worktree and never
deletes history, evidence or source automatically.

Use **Approve all pending test cases** in **Test case generation** above the cards to queue every pending
draft in the current application/suite filters at once. Choose **All applications**
and **All suites** for all drafts. Already queued cases are skipped. The result
lists each queued case or setup error; one blocked case does not stop the others.

The control room opens on **Run & review**, with test cases, acceptance and feedback.
Open its **Test case generation** tab for bulk approval, implementation details,
retries and generation progress. Suite/application filters and the selected case
are shared between tabs; unsaved review comments remain when switching views.
**Review draft** and **Review automation** open the generation tab for that case.
The view can be linked directly with `/?view=generation` and an optional `suite` query.

The **Test case generation progress** panel in that tab shows the latest automation attempt
for every approved case in the current filters. It refreshes every three seconds,
with queue/active/verified/error counts, current stages and messages, validation
results and links to implementation details. Finished counts include failures and
cancellations; only enabled, verified automation is shown as ready to run.

For a failed, interrupted or cancelled attempt, choose **Retry case generation**
on its progress row, selected-case panel or implementation details page. This
queues only that case, using the current clean application setup. Previous attempts,
logs and evidence are retained. Duplicate clicks reuse the queued retry. If the
case's steps changed, review and approve the updated case first. Fix any reported
prerequisite before retrying; the worker still requires two fresh passing validations.

Generation now checks the approved source and fixture prerequisites before building
the application. **Prerequisites missing** means the case needs a supported fixture
or application workflow; retrying unchanged setup cannot supply those capabilities.
No UAT run is created by a blocked planning attempt.
Known prerequisite blockers now disable retry and are excluded from bulk approval
until the definition, approved source or fixture engine changes. The server enforces
the same check, retaining the original blocker even behind later cancellations.
Transient build/browser failures remain retryable. New missing-prerequisite outcomes
are recorded as **Blocked**, separately from execution failures.

The panel shows progress, cancellation, logs, errors and validation links. Missing
fixture capabilities, unsupported actions and failed assertions leave the case
disabled with a reason. For example, the current Virtual Company fixture creates
a disconnected test company; it does not receive supplier invoices. Such scenarios
need a trusted fixture extension before they can run. A supported workflow can be
retried after fixing its prerequisite. Use **Disable test automation** to return a
verified case to draft while retaining history. See [test implementation](docs/test-implementation.md).

Generation requires a server-side OpenAI API key. In the PowerShell window used
to start the dashboard:

```powershell
$env:OPENAI_API_KEY = Read-Host 'OpenAI API key' -MaskInput
./scripts/start-dashboard.ps1 -Restart
```

The default model is `gpt-6-astra`; override it with `Getright__OpenAI__Model` if
needed. The explicit generation action sends the feature description, suite name
and application name to OpenAI, using its Responses API with a strict JSON schema
and `store: false`. It sends no run evidence, browser auth or application secrets.
Keep secrets out of suite descriptions. Keys stay on the server and are not
returned by status APIs or saved with proposals. No automatic provider retries
occur. Missing credentials, refusals, incomplete output and provider errors leave
the suite unchanged. See [suite and generation contracts](docs/test-suites.md).

For WriterApp, follow [the isolated host and setup instructions](docs/writerapp-uat.md).
Its first adapter has been verified against an actual local build. Milestone 1
remains in progress until all five workflows are implemented and validated.

For feedback implementation, see [Codex improvement jobs](docs/improvement-jobs.md).
Use a clean committed baseline and import its receipt before requesting a job.

Use `npx --prefix worker playwright show-trace <path-to-trace.zip>` to inspect a
downloaded trace. Task prompts and traces remain local unless you share them.

The demo uses a new browser context and unique fixture ID for each run. Its note is
stored in that context's local storage. This checks the demo workflow only; it does
not prove WriterApp server persistence or any Virtual Company business behavior.

To run without PowerShell scripts:

```text
dotnet run --project src/Getright.Dashboard --configuration Release --no-launch-profile
npm run start --prefix worker
```

The scripts keep .NET CLI/cache files inside ignored `.local/`. If your environment
restricts profile writes, use the scripts for builds or set `DOTNET_CLI_HOME` and
`NUGET_PACKAGES` to local writable directories.

## Local configuration

| Setting | Default | Purpose |
| --- | --- | --- |
| `Getright__DataPath` | `<repo>/data` for source builds | Dashboard database and evidence root. For published output, the fallback is `data` beside the assembly. |
| `GETRIGHT_DATA_PATH` | `<repo>/data` | Worker evidence root. Must match the dashboard data root. |
| `GETRIGHT_DASHBOARD_URL` | `http://127.0.0.1:5120` | Worker API origin; loopback HTTP only. |
| `GETRIGHT_RUN_TIMEOUT_MS` | `180000` | Standalone run deadline, 1000–600000 ms. |
| `GETRIGHT_HEADLESS` | unset / false | Set exactly `true` for headless execution. |
| `GETRIGHT_KEEP_BROWSER_OPEN` | unset / true | Set exactly `false` to close docked or visible UAT browsers after automation. |
| `ASPNETCORE_URLS` | `http://127.0.0.1:5120` | Dashboard listening URL. Use a matching worker URL if changing the port. |

Examples: `scripts/start-worker.ps1 -Headless`, or `-Once` to process at most one
queued run. Stop either foreground process with Ctrl+C. A dashboard restart marks
in-flight runs interrupted. A worker crash or lost connection expires its 45-second heartbeat lease; the
dashboard recovers it without waiting for another claim. Queue a new run rather
than overwriting the old result.

The dashboard and worker must share a local data directory. This version supports
one dashboard process per database and sequential execution per worker. There is
no remote worker transport, user authentication or hosted deployment configuration.

## Checks

```powershell
dotnet restore Getright.sln --locked-mode
dotnet build Getright.sln --configuration Release --no-restore --warnaserror
npm test --prefix worker
npm run smoke --prefix worker
npm run smoke:jobs --prefix worker
npm run smoke:virtual-company --prefix worker
npm run smoke:operations --prefix worker
npm run smoke:review --prefix worker
npm run smoke:suites --prefix worker
npm run smoke:quick-review --prefix worker
npm run smoke:test-page-panel --prefix worker
npm run smoke:live-dock --prefix worker
npm run smoke:steps --prefix worker
npm run smoke:startup --prefix worker
npm run smoke:case-implementation --prefix worker
npm run smoke:case-batch --prefix worker
npm run smoke:bulk-approval --prefix worker
npm run smoke:generation-progress --prefix worker
npm run smoke:case-generation-retry --prefix worker
npm run smoke:case-prerequisites --prefix worker
npm run smoke:worker-launch --prefix worker
```

The smoke check starts its own temporary dashboard on a free loopback port and
stores its database and screenshots in `.local/smoke-*`. It verifies the actual
Blazor UI, queue claiming, browser persistence checks, evidence access, feedback
export, independent acceptance, 390px layout, failed runs and restart recovery. It
does not touch either target application's repositories or data.

`smoke:case-implementation` uses a synthetic plan compiler with real Git and
browser validation. The opt-in `npm run smoke:case-implementation:live --prefix
worker` invokes actual Codex for a disposable note case. Add `-- --virtual-company`
to also build the configured clean Virtual Company revision and validate a
permission workflow using a synthetic plan compiler and fresh companies. It
retains local worktrees/commits and pending human acceptance, with providers disabled.

## Development

- [Product brief](docs/product-brief.md)
- [Architecture and trust boundary](docs/architecture.md)
- [API and runner contract](docs/contracts.md)
- [Milestones and application integration](docs/roadmap.md)
- [Codex jobs and linked reruns](docs/improvement-jobs.md)
- [Contributor instructions](AGENTS.md)

SQLite files, screenshots, traces, browser auth, local config and build outputs are
ignored by Git. The linked GitHub repository is public: only sanitized code and
documentation belong there. No product license has been selected for this starter.

## Virtual Company

Run `./scripts/start-virtual-company.ps1`. It starts Getright in the background if
needed, or reuses the healthy dashboard without restarting it. It then builds a
clean isolated Virtual Company instance and saves its receipt to application setup.
The worker still starts separately with `./scripts/start-worker.ps1`.
An observed native C# compiler crash (`Fatal error. 0xC0000005`) gets one bounded
fresh-process build retry, with the original failure retained in the local log.
This also recognizes MSBuild `MSB6006` when `csc.dll` exits with
`-1073741819`, the signed form of the same access-violation status.
Other build errors and cancellation stop immediately.
The first workflow creates a test company, saves draft permissions and verifies
reopening and access boundaries. See [Virtual Company UAT](docs/virtual-company-uat.md)
for SDK requirements, fixture boundaries and the opt-in real Codex cycle.

For cancellation, audit history, comparison and explicit local cleanup, see
[Local operations and recovery](docs/operations.md).
