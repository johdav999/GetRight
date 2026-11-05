# Approve and implement test cases

Open **Test case generation** in the control room, or select **Review draft** on
a case card to open that tab for the case. Review its steps and choose
**Approve and implement test case** above Workflow detail. Keep the dashboard and
local worker running. Restart an older worker with `./scripts/start-worker.ps1`
to load this capability. WriterApp and Virtual Company need an imported, ready,
isolated launch receipt from a clean committed source revision. Approval uses that
receipt without requiring its original manual-review host to remain running; the
worker builds/starts its own isolated runtime and verifies identity/build before
validation. Normal UAT runs and manual entry-page checks still require their
configured host. Approval cannot bypass isolation or a missing/dirty source receipt.

An older worker already running before this capability was added cannot claim
implementation jobs. If cases stay queued, restart that worker once. The current
launcher subsequently reloads worker source changes at idle boundaries, without
retrying failed work or interrupting an owned job. Dashboard upgrades can retain
an entirely unclaimed implementation queue using `-Restart -PreserveQueued` with
workers stopped; executing jobs still block the restart.

**Approve all pending test cases** above the catalogue approves all pending drafts
in the current application and suite filters. Use All applications and All suites
to cover all drafts. The count excludes cases already queued or being implemented.
The click freezes that list and each displayed definition digest; later filtering
or polling cannot broaden the batch. Each case uses the same setup and approval
checks as individual approval. Errors are listed per case while remaining cases
continue. Cancel remaining approvals stops the unprocessed part; already queued
jobs remain available for individual cancellation. Bulk approval does not accept
UAT runs or bypass the two-validation requirement.

The panel shows progress, cancellation, errors and validation links. **View
implementation, plan and logs** opens the frozen definition, provenance, committed
workflow, bounded logs and proof runs. Fix any reported prerequisite before
approving a new attempt. Existing attempts and worktrees remain available; no
automatic paid-provider retries occur.

Choose **Retry case generation** on a failed, interrupted or cancelled attempt to
queue just that case again. The button is available in its control-room progress
row, selected-case panel and implementation details page. It creates a new attempt
linked to the previous one, freezes the current clean application receipt, and
starts with no generated plan or proof runs. The previous attempt, logs, worktrees
and application-run reviews remain unchanged. Duplicate clicks/tabs share an
already queued retry. Known prerequisite blockers cannot be queued again with the
same definition, approved application source and installed fixture engine. This
check applies to individual retry, individual approval and bulk approval, including
blockers hidden behind later cancelled attempts or older history pages. Changing
only a runtime version, origin or account does not add fixture capabilities.
Fix the missing capability or review a changed definition/source before trying
again. Previous records are never rewritten. Legacy blockers use their retained
engine summary; unavailable provenance keeps them blocked for review.
Historical attempts link to the latest attempt instead of
offering another retry. Edited case definitions must be reviewed and approved
again; missing/dirty setup remains blocked. Fix the reported prerequisite first.

The **Test case generation** tab contains bulk approval, case implementation and
retry controls. **Run & review** keeps these out of the test-running workspace.
Switching tabs preserves suite/application filters, selection and unsaved review
comments. `/?view=generation&suite=<suite-id>` opens a scoped generation view.

The tab's **Test case generation progress** panel refreshes every three
seconds. It shows the latest automation attempt for each case in the current
application/suite filters, with queued/active/verified/attention/cancelled counts,
current stages, latest messages, validation results and detail links. Finished
counts include unsuccessful attempts; the separate ready count requires an enabled
binding for the configured source. Disabling automation retains its verified
attempt without showing it as ready. This panel tracks approved-case automation;
OpenAI draft proposals are generated and reviewed on the suite page.

After two passing validations, **Run UAT test** and **Open test page** become
available. Each application run still needs its own human acceptance. **Disable
test automation** removes the binding while retaining history. Reverify after
changing the clean application source or execution engine. Suite membership edits
do not invalidate case definitions or historical runs.

When only the execution engine changed, reverifying an existing verified binding
can reuse its committed plan if both the definition and approved application
source are unchanged. The new attempt freezes the source binding/job, verifies
the plan SHA-256 and matching Git artifact, and copies it into a new dedicated
worktree without a model call. It retains the original model thread provenance,
creates a new local commit and requires two fresh validation runs with the current
engine. The previous proofs and reviews remain unchanged. Changed definitions or
application source still require normal planning. The control room displays
**Reverify required** until current-engine proofs enable the binding again.

## Execution and attribution

Approval freezes the definition digest, stable step IDs and approved application
profile. Duplicate queueing while an attempt is active returns that attempt.
The worker creates a dedicated Getright worktree and branch
`codex/testcase-<job-id>` at committed HEAD, preserving the original dirty checkout.
It first enters **Planning**, using the approved application source to check fixture
prerequisites and generate the bounded plan. No application is compiled or started
at this stage. Missing capabilities produce an **Implementation blocked** reason
and a **Prerequisites missing** badge; the generated explanation remains available
as `workflow.json`. New attempts end in a distinct `blocked` state. This is a blocked automation attempt, not a failed application
UAT run. Source inspection and model assessment do not prove the workflow runs.
Only a contract-valid plan proceeds to commit, build, host startup and validation.
Planning is active leased work: cancellation, restart refusal and recovery apply.
Only `config/implemented-tests/<case-id>.json` may change. The bounded contract
cannot activate arbitrary JavaScript, commands, dependencies or application API
actions. Codex may return `blockedReason` when fixture capabilities are missing.
The artifact and source-diff boundaries are checked before a local commit.

The continuous worker claims up to ten consecutive compatible queued cases at
once. Each case retains its own lease, approved description, dedicated plan
worktree and local commit. All captured cases complete prerequisite checking and
plan preparation before compilation. Unsupported cases stay blocked independently.
Codex inspects application source for selectors but writes only its case's plan
artifact; test-case implementation does not combine application source changes.

For WriterApp and Virtual Company, prepared cases targeting the same application
source, selected SDK and build recipe share one compiled application build. The
build key includes application/source, SDK, platform/architecture and build/helper,
harness and dependency-lock digests. Different revisions are never grouped across
their FIFO queue boundary. Each case then gets a fresh host/data directory, runs
its two validations and stops that host before the next case starts. Cases are
enabled individually. Build versions and an artifact inventory/digest link each
case to its shared build owner and retained compiler log. Runtime and source
checks remain enforced; modified dependencies/static assets invalidate reuse.

This is a bounded queue batch, not a persistent build cache. Cases queued after
the snapshot or a worker restart form a new batch. `-Once` and older dashboards
retain the single-case path. No model or compilation retries are added. One case's
cancellation does not stop a compilation still needed by another case; stopping
all dependent cases or the worker aborts it. Shared build failures fail dependent
cases without fabricated proofs. All source worktrees/builds and history remain
retained; no automatic cleanup is introduced.

The worker retains the platform base/result commits, application source/build,
thread ID, raw-plan SHA-256 and execution-engine SHA-256. The engine digest covers
the interpreter, fixture/runner source, host fixture and locked worker dependencies.
Changed engines require reverification. Older workers cannot claim declarative runs.

Before worktree creation, the worker checks both worktree and data volumes for
5 GiB available (256 MiB for the demo). Insufficient space produces an actionable
terminal error before build expansion. It does not automatically remove retained
worktrees, build outputs, evidence or history.

Two validations execute every frozen step in order with separate browser contexts
and unique fixture IDs. WriterApp requires distinct document IDs; Virtual Company
requires distinct company IDs. Only an unchanged definition and both passing
results atomically enable the binding. Each run retains its own immutable snapshot,
identity, screenshots, trace and pending acceptance. Repeatability proof does not
replace human review of whether assertions cover the intended functionality.

No merge, deployment, publishing or application-source change is part of this
flow. Local worktrees, branches/commits and evidence remain for review. There is
no automatic cleanup of test-implementation worktrees.

## Supported workflows

Version 1 supports same-origin navigation/reload, fill/click/check/uncheck/select,
and assertions for visibility, text, value, checked state, enabled state, count and
URL. Every frozen step needs an assertion. Limits: 30 actions per step, 120 total,
64 KiB JSON. Unknown fields/actions, code, external paths and unsupported
placeholders are rejected by server and worker. Navigation stays on the validated
isolated application's origin.

| Fixture | Prepared state |
| --- | --- |
| `getright-note` | Blank local-storage note in a fresh browser context |
| `writerapp-document` | Fresh saved document in the verified isolated host |
| `virtual-company-test-company` | Fresh test company, disconnected sender and employee fixture; no enabled sending permissions |

Placeholders are `fixtureId`, `unique`, `email`, and the relevant `documentId` or
`companyId`. Setup is trusted worker source; plans cannot invent setup APIs. Virtual
Company reference-company access is checked before and after the workflow.
External providers and background jobs remain disabled by the isolated host.

Supplier-invoice delivery, accounting population, external transport, new roles
and general multi-user authentication are not supplied fixtures. Cases requiring
them must remain disabled with a missing-capability reason until a trusted fixture
extension exists. A generic visible-page assertion does not prove invoice delivery.

## API and recovery

| Method | Route | Purpose |
| --- | --- | --- |
| POST | `/api/tests/{id}/approve-implementation` | Approve the displayed `definitionDigest` and queue |
| GET | `/api/tests/{id}/implementation-readiness` | Check known prerequisite blockers against current definition, source and fixture engine |
| POST | `/api/tests/{id}/disable-implementation` | Remove binding; retain history |
| GET | `/api/case-implementations?test={id}` | Latest attempts for a case |
| GET | `/api/case-implementations/{id}` | Definition, identities, status and proof runs |
| POST | `/api/case-implementations/{id}/retry` | Retry the latest unsuccessful attempt with its unchanged `definitionDigest`; retain `retryOfJobId` |
| GET | `/api/case-implementations/{id}/events?after={sequence}` | Incremental progress |
| POST | `/api/case-implementations/{id}/cancel` | Request cancellation |
| GET | `/api/case-implementations/{id}/artifacts/{file}` | Only codex.log, build.log, workflow.json or summary.json |
| POST | `/api/worker/case-implementations/claim` | Claim next queued attempt with private lease |
| POST | `/api/case-implementations/{id}/heartbeat` | Renew ownership |
| POST | `/api/case-implementations/{id}/report` | Record forward progress and immutable identities |
| POST | `/api/case-implementations/{id}/validate` | Create next leased validation, ordinal 1 or 2 |
| POST | `/api/case-implementations/{id}/finish` | Enable with passing proofs, or retain terminal failure |

Worker writes require a private lease, renewed every five seconds and expiring
after 45 seconds. Cancellation aborts owned operations; restart/lease loss
interrupts the attempt and active validation. Stale completions cannot activate
automation. Cancel validation through its owning implementation. Dashboard
restart/stop refuses queued or active test implementation as well as other work.

## Verification

`npm run smoke:case-implementation --prefix worker` uses a synthetic compiler with
real Git, dashboard and Chromium. It covers approval, stale definitions, duplicate
queueing, proof requirements, two fresh validations, normal rerun, independent
acceptance, disabling, failed assertions, unsafe actions, active cancellation,
lease expiry, restart recovery and desktop/mobile UI. Databases are disposable.

`npm run smoke:bulk-approval --prefix worker` checks the bulk UI, application/suite
scope, duplicate exclusion, per-case setup failures, cancellation, frozen batches
during filter changes and additions, unchanged acceptance and desktop/mobile layout.
It queues disposable jobs without invoking Codex or changing application data.

`npm run smoke:case-batch --prefix worker` uses a synthetic compiler, real Git and
isolated WriterApp-shaped browser hosts. It verifies all plans precede one build,
fresh sequential hosts/data, per-case activation, retained build provenance,
incompatible source boundaries, exclusive batch claims, prerequisite/build failures,
cancellation/shutdown and binary tampering. It invokes no paid model. The opt-in
`smoke:case-batch:live` copies two retained permission plans into disposable cases,
builds the configured clean Virtual Company revision once, then verifies four
passing runs with four fresh companies in two sequential hosts. It invokes no new
model and retains pending human acceptance. It needs a configured source receipt
and two existing permission plans for that revision.

`npm run smoke:generation-progress --prefix worker` exercises live polling,
progress rollups, failures, disabled bindings, validation states, latest jobs/events
beyond history-page limits, filters and mobile layout with synthetic worker-status
fixtures. It invokes no model and leaves all fixture run acceptance pending.

`npm run smoke:case-generation-retry --prefix worker` checks all three retry entry
points, single-case scope, duplicate requests, new-attempt provenance, retained
history/reviews, stale definitions, historical attempts, clean setup requirements
and desktop/mobile layout. It uses disposable status fixtures without invoking Codex.

`npm run smoke:case-prerequisites --prefix worker` checks that blocked and unsafe
plans never build or launch an application, supported plans proceed in order with
retained commit identity, and planning cancellation, leases and restart recovery
remain enforced. It uses real Git/browser fixtures with a synthetic compiler.

The opt-in `npm run smoke:case-implementation:live --prefix worker` invokes actual
Codex for a disposable note draft, commits its plan, validates twice and runs it
normally with pending acceptance. `-- --virtual-company` also builds the configured
clean Virtual Company revision and validates permissions using two fresh companies.
That extra flow uses a synthetic plan compiler with the real Web/API host; it is
not a provider or invoice integration test.

Recorded local validation on 2026-11-02:

- Contract/cancellation: `.local/case-implementation-1793642685488/case-implementation-report.json`.
- Actual Codex note and real Virtual Company permissions:
  `.local/case-live-1793642686349/live-report.json`.

Evidence, logs, host data and task exports stay ignored locally. Only the bounded
artifact is committed in its dedicated local worktree. No check merges or publishes.
