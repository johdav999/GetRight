# Milestone 2: feedback-to-fix jobs

Getright can turn feedback from WriterApp's create/save/reopen workflow into an
editable Codex task, implement it in a new Git worktree, commit and build the
change, launch an isolated instance and rerun the original frozen test. The job
page links the original and new runs and shows their step evidence together.

## Run a job

1. Make sure the local worker can use Codex. It uses the existing Codex sign-in;
   `codex login status` checks it and `codex login` establishes it if needed.
   No API key, password or browser session is entered into the dashboard.
2. Configure WriterApp as described in [WriterApp UAT](writerapp-uat.md). For an
   implementation job, use a clean committed checkout and import its build receipt
   so the tested source revision is retained. Run the test against that instance.
3. Open the completed run, describe an improvement at a test step, and select
   **Prepare Codex job**. Review and edit the task, then **Save task**.
4. Select **Implement improvement**. Creating feedback or a draft never starts
   Codex. The normal local worker handles the queued job.
5. Follow preparation, Codex progress, the build, launch verification and rerun on
   the job page. **Cancel job** requests cancellation of the active worker.
6. When the job reaches **Awaiting review**, compare the screenshots, inspect the
   result commit/diff and open the regression run to make a new acceptance decision.

The worker stops the changed application after its regression test. The worktree,
local branch, build outputs and logs remain available for inspection. It does not
stop an original application instance that it did not start. Failed/cancelled jobs
are retained too; create a new task draft to retry rather than overwrite history.

## Reproducible source

A draft may be prepared from any feedback, but implementation currently requires
an actual WriterApp create/save/reopen run with a verified build/account, a Git
source commit, and `sourceWasDirty: false`. Editing a profile later cannot change
the original run's source. A dirty or missing source receipt blocks implementation.

If the main checkout contains local work, use a separate clean baseline without
changing or committing it. For example, from Getright in PowerShell:

```powershell
$baseline = Join-Path $PWD 'worktrees/wa-base'
$commit = git -C ../WriterApp rev-parse HEAD
git -C ../WriterApp worktree add --detach $baseline $commit
.\scripts\start-writerapp.ps1 -RepositoryPath $baseline -Port 5401
```

Import the printed receipt through the setup API, run the test and create feedback
from that run. Do not reuse an unrelated older receipt for a running application.
For very long Windows checkout paths, choose a shorter baseline directory.

## Worker configuration

The default target repository is the sibling `../WriterApp` Git root. It must
contain the original tested commit. The worker does not fetch repositories or
execute commands supplied by task text or HTTP requests. Its WriterApp build and
launch adapter is fixed source code.

Copy `config/worker.example.json` to ignored `config/worker.local.json` to override:

```json
{
  "writerapp": { "repositoryPath": "../WriterApp" },
  "worktreeRoot": "worktrees",
  "codexTimeoutMs": 1800000,
  "buildTimeoutMs": 300000
}
```

Paths are resolved from the Getright repository root. `GETRIGHT_WORKER_CONFIG` can
select another local configuration file. `codexModel` is optional; omitting it
preserves the configured Codex model. Timeouts must be between 1 second and 1 hour.

Worktrees are named with a 12-character job prefix under `worktreeRoot`, outside
the original checkout. Existing directories are never overwritten. The branch
name retains the full job ID: `getright/job-<job-id>`. On Windows, worktree paths
longer than 110 characters are rejected before Codex starts. Set a short absolute
`worktreeRoot` if needed. Builds use a short per-worktree `artifacts/gr` directory
because some WebAssembly build tools still have path-length limits.

## Identity and permissions

- The original run, feedback ID and reviewed prompt are fixed once execution starts.
- The worker verifies the configured repository and creates the worktree at the
  original tested commit. The original checkout and branch are preserved.
- The [official Codex SDK](https://learn.chatgpt.com/docs/codex-sdk) streams local
  thread events. It runs with workspace-write permissions, no command-network
  access, disabled web search and no automatic escalation. A blocked turn fails
  the job instead of broadening permissions. The thread ID is persisted.
- The worker commits the source diff on the isolated branch. A no-change result or
  unexpected HEAD movement fails the job. Hooks/signing are disabled for these local
  artifact commits, avoiding unattended hooks and signing prompts.
- Each build gets a distinct four-part assembly version. Build changes to tracked
  source fail attribution checks. Runtime readiness requires that exact version.
- The changed application uses a fresh local database, the isolated Development
  `dev-oid` identity, and disabled AI/billing/collaboration flags. Inherited app
  secrets and database settings are excluded from build/runtime environments.
- The regression run records the resulting commit, runtime version, account,
  fixture and original test snapshot. Acceptance starts pending.

This remains a trusted local development tool. Generated application code is built
and launched as the local worker user. The Codex sandbox is not an OS sandbox for
the generated application's build/runtime. Repositories, worker configuration and
the decision to implement a reviewed task must come from the trusted local operator.

## Progress, cancellation and recovery

Job states are `draft → queued → preparing → implementing → building → launching →
rerunning → awaiting-review`, with `failed`, `cancelled` and `interrupted` outcomes.
Draft updates use a revision number; stale edits and repeated starts are rejected.

The worker renews its private 45-second lease every five seconds and checks for
cancellation. It aborts Codex/build/test operations and stops only processes it
created. Worker shutdown or loss of the lease interrupts the job. Dashboard
restart invalidates active jobs and their in-flight regression runs. Expired
leases are detected when jobs are read or claimed; this is not a durable remote
queue or a process-monitoring service. There is no automatic retry.

Events are persisted and loaded incrementally by the dashboard. Code/build/launch
logs are bounded to 2 MiB each. Available logs, `diff.patch` and `summary.json` can
be downloaded from the job page. Everything stays in ignored local data/worktrees;
these artifacts can contain private source and application content.

## Validation

```powershell
npm test --prefix worker
npm run smoke --prefix worker
npm run smoke:jobs --prefix worker
```

The job smoke check uses actual Git worktrees, commits, the dashboard and browsers,
with explicitly synthetic Codex/build/runtime adapters. It checks editing, Unicode
prompts, source gating, isolation, failure/cancellation, stale leases and restarts.
It does not claim to exercise Codex or a live WriterApp build.

The opt-in live cycle runs the real Codex SDK and actual WriterApp builds:

```powershell
npm run smoke:cycle --prefix worker
```

It uses the signed-in Codex account, creates a clean baseline worktree, runs the
initial test, requests a small Documents-library subtitle correction, implements
it through Codex, and verifies the new build and linked regression run. Reports
and screenshots stay in `.local/cycle-live-*`; worktrees/commits are retained for
review. Nothing is merged or published, and human acceptance stays pending.

The real cycle passed on 2026-11-02. It used clean WriterApp base commit
`0d204d7fea55f673dee35d7b9e90a6d78da297f9`, produced local result commit
`bf0be16a14667dc20d55126b41ae99212709a329` on branch
`getright/job-642754d6cfab4713ad549b462fccc033`, and verified running build
`0.2.25639.21718` before the passing linked rerun. The Documents subtitle changed
to “Create a document or open a saved draft to continue writing.” Projects retained
its existing wording. The regression run remains pending human acceptance.
Existing dependency-audit warnings in WriterApp were recorded in the build logs;
Getright did not change those dependencies as part of this milestone.
