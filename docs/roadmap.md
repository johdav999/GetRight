# Implementation milestones

The local demo, SQLite history, evidence capture and task export are the completed
starter baseline. Milestones 1–4 cover the initial application integrations and
operational foundation. Milestones 5–10 cover configuration-driven integrations.
Milestone definitions are kept in
`config/milestones.json`; new definitions do not create GitHub milestones automatically.

| Milestone | Outcome | Status |
| --- | --- | --- |
| [1 — WriterApp UAT](https://github.com/johdav999/GetRight/milestone/1) | Five repeatable workflows against isolated WriterApp data, with build/account checks and reviewable evidence. | In progress |
| [2 — Feedback-to-fix cycle](https://github.com/johdav999/GetRight/milestone/2) | An editable task becomes a Codex worktree job, a verified build and a linked rerun. | Implemented and validated |
| [3 — Virtual Company UAT](https://github.com/johdav999/GetRight/milestone/3) | Test-company setup and draft permissions use dedicated company data and the shared UAT cycle. | Implemented and validated |
| [4 — Operational polish and reliability](https://github.com/johdav999/GetRight/milestone/4) | Repeated cycles, cancellation, recovery, audit, cleanup and comparison work reliably. | Implemented and validated |
| [5 — Application manifests and reproducible configuration](#5--application-manifests-and-reproducible-configuration) | Versioned application definitions and worker identity become part of run attribution. | Implemented |
| [6 — Configurable runtime, identity and fixtures](#6--configurable-runtime-identity-and-fixtures) | Runtime checks, dedicated identities and disposable fixture setup use validated configuration. | Implemented |
| [7 — Declarative workflow execution](#7--declarative-workflow-execution) | A bounded action language drives browser/API tests with the existing evidence and review lifecycle. | Implemented |
| [8 — Trusted build and launch recipes](#8--trusted-build-and-launch-recipes) | The shared Codex cycle builds and launches configured applications without application branches in its orchestrator. | Implemented |
| [9 — Dashboard configuration and readiness](#9--dashboard-configuration-and-readiness) | Users configure applications, validate workflows and understand readiness blockers through the dashboard. | Planned |
| [10 — Integration migration and third-application proof](#10--integration-migration-and-third-application-proof) | Existing integrations retain their checks, and a third application is onboarded through configuration alone. | Planned |

## 1 — WriterApp UAT

- [x] Local application setup page and persistent configuration.
- [x] Check the actual running version and dedicated test account before queueing.
- [x] Freeze the target profile into each run, independently of later setup edits.
- [x] An isolated WriterApp launcher with a new database, test identity and unique
      assembly version; no source or normal application config changes.
- [x] Implement the create/save/reopen adapter through the WriterApp UI, with
      backend readback and per-step evidence.
- [x] Verify that first adapter against an actual isolated WriterApp build.
- [ ] Validate and accept all five workflows against actual WriterApp builds.
- [ ] Implement synopsis with controlled provider responses.
- [ ] Implement edits surviving navigation and reopening.
- [ ] Implement sharing/acceptance using separate authenticated identities.
- [ ] Implement failed-save recovery using a bounded, controlled failure.

The first implementation slice supplies setup, preflight checks and the persistence
adapter. Milestone 1 remains open until all five workflows are implemented and
validated. Contract-host tests only test Getright; they are not WriterApp acceptance.

Acceptance: runs retain the runtime build, account, fixture, document identity,
screenshots and trace. Wrong builds/accounts cannot create test data. New runs
always await a fresh human decision. Established step IDs remain stable.

See [WriterApp setup](writerapp-uat.md) for running the current slice. Current
starting references in the sibling checkout are `Tests/sharing-workspace.mjs`
and `docs/writing-tools-redesign-uat.md`; inspect current source before adapting.

## 2 — Feedback-to-fix cycle

- [x] Persist editable task drafts with revision checks and explicit implementation.
- [x] Create an isolated worktree at the original tested source commit.
- [x] Run the real Codex SDK, stream progress and retain the thread ID.
- [x] Commit the change locally and capture bounded build/start logs.
- [x] Verify the changed runtime version and rerun the original frozen test.
- [x] Link original run, feedback, job, resulting commit/build and regression run.
- [x] Present before/after evidence with new human acceptance pending.
- [x] Validate failures, cancellation, lease expiry and restart recovery.
- [x] Complete an actual WriterApp feedback-to-fix cycle through Codex.

Validated on 2026-11-02: Codex corrected the Documents library subtitle on a local
worktree branch, the changed build passed create/save/reopen checks, and the new
run stayed pending acceptance. The original WriterApp checkout/branch was preserved.
See [improvement jobs](improvement-jobs.md) for usage and validation scope.

Persist editable improvement jobs linked to feedback and the original run. Start
Codex only from an explicit Implement action, using a new Git worktree at a
recorded base commit. Stream progress and errors, retain thread/job IDs, and
capture bounded build/start logs. Verify the running changed version before
rerunning the original test with fresh data. Present linked old/new evidence for
a new human acceptance decision. Include cancellation and failure paths.

Acceptance: one real WriterApp improvement completes original run → feedback →
job → resulting commit/build → rerun. No automatic merge, deployment or acceptance.

## 3 — Virtual Company UAT

- [x] Select a first workflow: create a test company, save draft-only email permissions and reopen it.
- [x] Build an isolated real Web/API host with fresh SQLite, synthetic owner/employee identities and a reference company.
- [x] Freeze and verify the actual build, account, owner role and reference company before execution.
- [x] Retain the created company identity, screenshots and trace; verify persistence, employee read/write denial and outsider denial.
- [x] Use the shared job pipeline to build a changed Virtual Company worktree and rerun the original frozen workflow with fresh data.
- [x] Validate an actual Codex feedback-to-fix cycle and keep the new acceptance pending.

Validated on 2026-11-02: Codex clarified the English creation description on an
isolated branch. The resulting build passed the original workflow and a visible
copy check. Original and changed companies/users were separate, and the sibling
checkout's HEAD was preserved. The local SQLite harness is not production SQL
Server or external-provider acceptance. See [Virtual Company UAT](virtual-company-uat.md)
for setup, attribution, fixture boundaries and cleanup. Expand to further workflows
after the first is accepted.

Acceptance: the chosen business outcome is repeatable and isolated, evidence
identifies the running build and role, and a user can review the complete cycle.

## 4 — Operational polish and reliability

- [x] Standalone run heartbeat, cancellation, bounded execution and browser shutdown.
- [x] Background lease recovery and rejection of stale writes after expiry/restart.
- [x] Separate child-process owners that stop owned commands after worker death.
- [x] Transactional review audit, including feedback-induced acceptance changes.
- [x] Paged history/jobs and stable browsing while new runs arrive.
- [x] Desktop/mobile comparison of any two runs of the same test.
- [x] Explicit evidence retention and reviewed clean worktree removal, with a cleanup journal.
- [x] Validate modified/unrelated resource refusal, partial cleanup, retry and restart.
- [x] Fix early pagination clicks and verify the real dashboard flows.

Validated on 2026-11-02: 18 worker checks, the existing demo/WriterApp/job/Virtual
Company contracts, the five-flow operational acceptance suite and a fresh live
Virtual Company UI/API run passed. Schema 4 preserves existing history. Selected
cleanup retains review metadata, feedback, logs, branches and source commits.
Remote authentication remains conditional on a future hosted deployment.
See [Local operations and recovery](operations.md) for limits and validation scope.

Acceptance: the local app handles repeated UAT cycles, interrupted work, failed
builds and cleanup without losing history or mixing acceptance between runs.

## Configuration-driven integration plan

The target is a shared control room, an application manifest and a set of workflow
definitions. Applications using supported capabilities should require only
configuration. Unusual authentication, editors or host infrastructure may require
a registered extension; extensions remain trusted source code with explicit
versions and contracts, rather than scripts supplied by tests or feedback.

Use JSON initially to match the existing catalogue and avoid maintaining multiple
configuration formats. Keep portable definitions in source control and machine
paths, credentials and environment bindings in ignored local configuration.
Manifests describe required capabilities, not permission to enable them.

Implement 5 → 6 → 7 → 8 → 9 → 10. Keep the existing adapters usable during the
transition. Milestone 1's remaining workflows remain outstanding; this plan does
not enable those drafts or imply their implementation or acceptance.

Every milestone preserves the local-only boundary, immutable run attribution,
stable step IDs, dedicated UAT identities and data, independent human acceptance,
and the dedicated-worktree/result-commit/verified-rerun rules for Codex jobs.
Fixture lifecycle operations must stay separate from evidence/worktree retention;
fixture teardown must not remove review evidence or audit history.

## 5 — Application manifests and reproducible configuration

Depends on: the existing run, job and operations foundation.

- [x] Define a versioned JSON manifest with capabilities, adapter versions, a
      manual review path and a reference to the existing fixture/runtime checks.
- [x] Add a trusted integration registry shared in contract by dashboard and worker;
      wrap existing adapters without changing their behavior. Unknown capability,
      adapter and schema versions fail closed with actionable diagnostics.
- [x] Introduce typed resource references (`kind`, `id`, optional scope) and
      retain the required result facts in the registered fixture contracts.
      Preserve legacy run/profile payloads through an explicit SQLite migration.
- [x] Freeze resolved non-secret manifest/workflow definitions, local binding
      identities, content digests and required engine/extension versions per run.
      Record the worker protocol and engine fingerprint; reject incompatible execution.
- [x] Keep credential fields out of manifests and bindings. Existing test identity
      checks remain in place; configurable authentication belongs to milestone 6.
- [x] Make reruns retain original definition snapshots, with only explicitly
      permitted build/instance/fixture bindings changed and recorded.

Completion criteria: existing history remains readable; editing a manifest after
queueing cannot change a run; incompatible workers cannot execute it; unknown
schemas and missing required result facts are rejected. Existing smoke suites
continue to pass, and new runs and reruns still start pending human acceptance.

See [application manifests and run configuration](architecture.md#application-manifests-and-run-configuration)
for the supported fields and worker upgrade behavior.

## 6 — Configurable runtime, identity and fixtures

Depends on: milestone 5.

- [x] Implement reusable bounded HTTP checks for status, typed response-field
      extraction, equality, membership and readiness polling. Use the same check
      semantics for dashboard preflight and worker verification.
- [x] Describe runtime version, account, roles and tenant/scope checks in manifests.
      perform read-only identity/build checks before any fixture mutation and
      verify the runtime again after workflow execution.
- [x] Support named dedicated test identities and isolated request sessions, initially
      existing development identities plus a configurable form-login flow.
      Unsupported external authentication remains a visible readiness blocker.
- [x] Define fixture setup/teardown using bounded requests, generated unique
      values and typed captured resource IDs. Restrict teardown to owned fixtures and
      report partial setup and cleanup failures without hiding the original result.
- [x] Bind request destinations to validated local origins and constrain redirects,
      interpolation and secret handling for browser and API traffic alike.
- [x] Keep app-specific harnesses as registered extensions where needed, including
      Virtual Company's disconnected host. Configured fixture recipes require an
      isolated host capability and run-owned resource receipts.

Completion criteria: configuration expresses existing build/account checks and
representative role/scope checks. Wrong build, wrong account, wrong scope and
unverified isolation block mutation. Separate user sessions cannot inherit each
other's authentication. Disposable-fixture tests cover partial setup and teardown.

The runtime configuration smoke uses a disposable host to verify separate form
sessions, bounded polling, preflight and postflight identity drift, partial
setup, and refusal to delete another run's resources. See the
[runtime plan contract](architecture.md#runtime-plans).

## 7 — Declarative workflow execution

Depends on: milestones 5 and 6.

- [x] Define a validated action language for navigation, locators by role/label/test
      ID or selector, click, fill, check, reload, bounded wait/poll and assertions.
- [x] Reuse isolated runtime sessions for persistence readback, HTTP assertions
      and typed value capture. Correlate response waits with the triggering action
      so configuration cannot miss fast creation responses.
- [x] Support named API sessions, fixture variables and resource references with
      restricted interpolation. Validate action inputs and variable references
      before execution, including missing and secret-valued references.
- [x] Preserve stable test/step IDs, screenshots, traces and step errors through
      the existing runner contract. Keep automated status and human review separate.
- [x] Bound every action and the full run, and propagate cancellation, lease loss and
      browser failures. Allow bounded retries for GET. Execute mutations once.
- [x] Provide versioned registered extensions for unsupported interactions, with
      declared inputs/results and the same deadline/evidence contract. Do not add
      arbitrary JavaScript, shell actions or unbounded control flow to workflows.

Completion criteria: a configuration-only disposable workflow creates, saves and
reopens a resource with backend readback and normal evidence. Negative tests cover
missing elements, failed persistence, bad variables, forbidden origins, deadlines
and cancellation. All use ordinary run history, feedback and fresh human review.

The authored workflow smoke exercises browser creation, correlated response
capture, persistence readback, reopening, a named API session and stepped review.
The version 1 engine remains available for previously verified cases. See the
[workflow authoring contract](architecture.md#authored-browser-and-api-workflows).

## 8 — Trusted build and launch recipes

Depends on: milestones 5–7.

- [x] Separate the job orchestrator from repository layout, build, launch and
      runtime-probe choices. Resolve those choices through manifest capabilities
      and trusted local recipe bindings.
- [x] Implement bounded process recipes with fixed variables and argument arrays,
      environment allowlists, working-directory constraints, readiness checks,
      owned processes and reliable shutdown. Do not interpret shell strings.
- [x] Keep executable/repository authorization in trusted worker configuration.
      Manifests select permitted recipe IDs. Feedback stays outside the recipe inputs.
- [x] Generalize build receipts and runtime version injection beyond .NET while
      retaining the clean base commit, result commit and compiled artifact identity.
- [x] Preserve repository preparation requirements through explicit recipes or
      registered host extensions, including Virtual Company's sparse checkout and
      multi-process host. Record recipe/extension versions in run/job attribution.
- [x] Declare testing and Codex implementation as separate capabilities. An app
      with only a verified running instance can be tested while Implement stays blocked.

Completion criteria: synthetic Git/build/launch job tests exercise two different
recipe shapes without app-ID branches in the orchestrator. Failed builds, changed
artifacts/source, startup failure, worker death and cancellation retain attribution
and stop owned processes. A passing linked rerun leaves acceptance pending; no
merge, push, deployment or publication is introduced. Live Codex checks stay opt-in.

The built-in extension and Node process paths are covered by disposable job
smokes. Shared case validation covers one sealed build with separate hosts and
proof runs. See the [recipe configuration contract](architecture.md#trusted-build-recipes).

## 9 — Dashboard configuration and readiness

Depends on: milestones 5–8.

- [x] Populate application setup from manifests and supported capability schemas,
      replacing hard-coded application options and company/document fields.
- [x] Allow importing and revising non-secret manifests/workflows, binding local
      instance/account settings and selecting pre-authorized recipes. Keep worker
      command authorization outside the dashboard configuration API.
- [x] Add schema validation and a read-only preflight preview showing the target,
      runtime identity, fixture plan and blockers; preview must not create data.
- [x] Keep imported workflows disabled until schema/capability checks, verified
      build/auth/isolation setup and a repeatability qualification are recorded.
      Qualification uses the normal run/evidence contract with human review pending;
      definition changes invalidate it, and every run rechecks its actual target.
- [x] Show whether an app supports testing, fixture provisioning and Codex fixes,
      with precise blockers for unsupported or unconfigured capabilities.
- [x] Surface frozen configuration versions on runs, jobs, comparisons and task
      previews, while redacting credentials and retaining existing audit history.

Completion criteria: desktop/mobile dashboard flows configure a sample application,
diagnose invalid definitions and stale build bindings, qualify a disposable test
and review its evidence. API calls cannot bypass readiness or enable unsupported
execution. Editing configuration does not rewrite historical runs or acceptance.

Implemented and validated with `npm run smoke:application-configuration --prefix worker`.
The smoke exercises desktop and mobile setup, two passing qualification runs
against a disposable WriterApp contract host, queue races and historical
acceptance after editing and restarting. See the [configuration guide](architecture.md#dashboard-configuration-and-qualification).

## 10 — Integration migration and third-application proof

Depends on: milestones 5–9.

- [x] Convert the demo and existing WriterApp workflow to manifests/workflows,
      retaining onboarding, persistence readback, resource IDs and stable steps.
- [x] Convert Virtual Company's current workflow, retaining reference-company
      comparison, owner/employee/outsider checks, draft-only permissions and build
      attribution. Keep genuinely custom host infrastructure in an explicit extension.
- [x] Remove obsolete app-ID branches from setup, runner, completion validation
      and job orchestration after equivalent coverage passes. Keep legacy history
      compatible and clearly identify any remaining custom extensions.
- [x] Add a disposable third sample web application on a different stack, such as
      Node.js, with actual UI/backend persistence and a local version endpoint.
      Onboard it by adding only configuration/workflow definitions and trusted
      local recipe bindings; make no Getright engine or dashboard source changes
      during that onboarding exercise.
- [x] Demonstrate third-app setup → test → evidence → feedback → configured job →
      changed build → original frozen workflow rerun. Use synthetic job execution
      in CI and a separate opt-in real Codex cycle; retain pending human acceptance.
- [x] Document the authoring guide, capability/extension matrix, migration and
      rollback procedure, recipe trust boundary and remaining unsupported cases.

Completion criteria: existing automated suites pass after migration, and fresh live
WriterApp/Virtual Company runs preserve their original business and isolation
assertions. The third-app onboarding diff contains no core source changes. Its
test and real Codex-cycle evidence are distinguished from synthetic contracts;
sample-app success is not acceptance of either target application. Human review
and implementation status are recorded separately for all new runs.

The Release build, worker tests and automated smoke suite passed. Fresh isolated
builds of WriterApp and Virtual Company passed their migrated workflows.
Sample Notes passed both the synthetic CI scenario and the opt-in real Codex
cycle. Onboarding used the same dashboard binary and changed only the catalogue
entry, manifest, workflow and worker-local recipe binding. Its changed build
passed the frozen workflow with a new owned fixture and pending acceptance.
See the [application authoring and rollback guide](application-authoring.md).
