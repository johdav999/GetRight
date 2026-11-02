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
- A local Node.js / Playwright worker with a visible browser by default.
- An isolated demo test that creates, saves and reopens a note, capturing step
  screenshots, a trace, fixture identity and the running assembly version.
- Step-specific feedback, task previews and downloadable implementation prompts.
- WriterApp application setup, runtime build/account checks, and a create/save/reopen
  adapter against an actual isolated WriterApp instance.
- Four remaining draft WriterApp tests; Virtual Company creation and draft-permission UAT.
- Editable Codex jobs, isolated worktrees/commits, streamed progress, bounded build
  and launch logs, runtime version checks, linked reruns and before/after evidence.
- Run/job cancellation, heartbeat leases, bounded execution and restart recovery.
- Review audit history, paginated history, run comparison and explicit evidence/worktree cleanup.
- Build checks, a browser/API smoke check, GitHub Actions and an issue template.

**Not implemented yet:** the remaining WriterApp adapters and external/multi-user login.
Cleanup is explicitly selected and confirmed; automatic scheduled purges are not
enabled. See the [four-milestone roadmap](docs/roadmap.md).
Draft tests are disabled. Codex starts only after the explicit Implement action.

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

In another terminal, also at the repository root:

```powershell
.\scripts\start-worker.ps1
```

Open [Getright on this computer](http://127.0.0.1:5120). Select **Run UAT test** on
the Getright demo. The worker opens a browser, performs four repeatable steps and
reports the result. Open its run history entry to inspect screenshots and download
the trace. Accept the run, or choose a step and create an improvement task.

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
```

The smoke check starts its own temporary dashboard on a free loopback port and
stores its database and screenshots in `.local/smoke-*`. It verifies the actual
Blazor UI, queue claiming, browser persistence checks, evidence access, feedback
export, independent acceptance, 390px layout, failed runs and restart recovery. It
does not touch either target application's repositories or data.

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

Start the dashboard, then run `./scripts/start-virtual-company.ps1`. The launcher
builds a clean isolated instance and saves its receipt to application setup.
The first workflow creates a test company, saves draft permissions and verifies
reopening and access boundaries. See [Virtual Company UAT](docs/virtual-company-uat.md)
for SDK requirements, fixture boundaries and the opt-in real Codex cycle.

For cancellation, audit history, comparison and explicit local cleanup, see
[Local operations and recovery](docs/operations.md).
