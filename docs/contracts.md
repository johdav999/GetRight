# API and runner contract

All routes are loopback-only. POST bodies are JSON where required. Invalid
workflow state and unknown identifiers return 400; unregistered
evidence and missing task exports return 404. Request bodies are limited to 256 KiB
to support bounded Unicode prompts; interactive messages are limited to 128 KiB.
No CORS policy is enabled.

Schema 5 also provides [suite, generated-case proposal and manual entry-page
contracts](test-suites.md#api). The catalogue includes persisted drafts; they stay
disabled for automation until execution support is implemented.

Schema 6 added [explicit draft implementation and verification](test-implementation.md#api-and-recovery).
Verified implementations are frozen in run snapshots, including plan/engine digests
and source attribution. Schema 7 adds application manifests and worker attribution.
Schema 8 adds local manifest revisions, imported workflows and qualification history.
Bodyless run claims can only take eligible pre-upgrade runs without a snapshot.

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/api/health` | Getright name, running assembly version and local mode. |
| GET | `/api/operations/active` | Total queued/running runs, jobs, cleanup tasks and caseImplementations, used by restart/stop checks. |
| GET | `/api/catalog` | Applications and test definitions. |
| GET | `/api/applications/{id}/profile` | Local profile or null; no credentials. |
| POST | `/api/applications/{id}/profile` | Save application URL, expected build/account, company/role if applicable, and isolation confirmation. |
| GET | `/api/applications/{id}/readiness` | Read-only checks of the running version/account. |
| GET | `/api/runs` | Latest 100 runs, newest first; excludes worker lease. Use paginated history for older runs. |
| GET | `/api/runs/{id}` | Run snapshot and current human acceptance. |
| POST | `/api/runs` | Queue `{ "testId": "getright-save-note" }`. |
| POST | `/api/worker/claim` | Oldest compatible queued run with private lease, or 204. |
| POST | `/api/runs/{id}/complete` | Submit terminal automated result with valid lease. |
| POST | `/api/runs/{id}/review` | Set `{ "acceptance": "accepted" }`, pending or improvements-requested. |
| GET | `/api/runs/{id}/feedback` | Original comments and generated prompts. |
| POST | `/api/runs/{id}/feedback` | Create step-specific feedback and a task draft. |
| GET | `/api/runs/{id}/tasks/{feedbackId}` | Download the generated plain-text task. |
| GET | `/api/evidence/{id}/{file}` | Serve a referenced screenshot or trace only. |

## Local application configuration

| Method | Route | Purpose |
| --- | --- | --- |
| GET / POST | `/api/applications/{id}/manifest` | Read the effective manifest or save a local revision. |
| GET | `/api/applications/{id}/recipes` | List locally authorized recipe IDs and versions for the application. |
| POST | `/api/applications/{id}/preview` | Check a proposed profile using the effective manifest and return readiness, target identity and the fixture plan. |
| GET / POST | `/api/applications/{id}/workflows` | List, import or revise local version 2 workflows. |
| GET | `/api/tests/{id}/qualification` | Read qualification status and proof runs for the current configuration. |
| POST | `/api/tests/{id}/qualify` | Queue one qualification attempt using the saved binding. |

Definition writes accept `revision` and `definitionJson` containing the JSON
definition as a string. Use the current revision when editing. To import a new
workflow, use revision `0`. Include the existing workflow `id` when revising.
Preview accepts the same profile shape as the binding endpoint without persisting
it. Responses expose identity details without credential values.

Normal queue and manual open requests require the two most recent qualification
attempts for the exact imported workflow revision, manifest and binding to pass.
Each qualification run starts with pending human acceptance. Run snapshots
retain `definitionRevision` for imported workflows and `qualificationKey` for
qualification attempts. The proof runs cannot be used to start improvement jobs.

## Run attribution and worker claims

New run payloads contain `configuration` with the manifest revision and schema,
manifest/workflow/binding fingerprints, adapter version and required workflow
engine (if any). The full workflow and application target remain in
`testSnapshot` and `target`. Legacy payloads may have no configuration. Passing
application results retain legacy identity fields and a typed `identity.resources`
list with `kind`, `id` and optional `scopeId`, derived from the validated adapter result.

Version 2 workflow claims require `integrationContractVersion: 1` alongside
`configuredWorkflowVersion: 2` and a configured engine digest. This lets
upgraded dashboards refuse workers that cannot execute the migrated workflows.

Worker run and job claims send `{ "runConfigurationVersion": 1,
"workflowEngineDigest": "<sha256>", "supportsStepControl": true, "runtimeContractVersion": 1 }`. A worker
without a compatible declaration cannot claim new runs or improvement jobs;
verified workflows also require a matching engine digest. Improvement rerun and
case validation requests include `worker: { "runConfigurationVersion": 1,
"engineDigest": "<sha256>", "runtimeContractVersion": 1 }` to record the worker on the direct-start run.
Runs with configured runtime plans require a compatible runtime worker. Their
results include `runtime.verifiedAfter` and `runtime.fixtures`. Passing results
require post-execution verification and successful cleanup of every declared fixture.

For `configured-v2`, workers also advertise `configuredWorkflowVersion: 2` and
`configuredWorkflowDigest`. The same fields appear in the direct-start `worker`
object. The authored plan is frozen in `testSnapshot.workflow`. The response
records `steps[].apiObservations` with method, resolved path, status, and optional
session. Passing steps require the HTTP statuses declared in the frozen plan.

Workers also advertise `buildRecipeVersion: 1` on improvement and case claim
requests. A recipe-backed job records the authorized `recipe` ID and version.
Improvement launch reports must supply `buildReceipt` with the recipe reference,
`recipeDigest`, and `artifactDigest`. A linked rerun target carries the same
receipt. Case validation targets include the recipe receipt and match any shared
build attribution. Legacy records can lack these fields.

Health also reports `instanceId`, `processId` and `dataPath` for local launcher
ownership checks. It includes no credentials. Database ownership is acquired
before RunStore recovery, independently of HTTP port ownership.

## Completion example

```json
{
  "lease": "<private lease from claim>",
  "status": "passed",
  "buildVersion": "<actual running application version>",
  "baseUrl": "http://127.0.0.1:5120",
  "steps": [
    { "stepId": "open", "status": "passed", "screenshot": "<run-id>/open.png", "error": null }
  ],
  "trace": "<run-id>/trace.zip",
  "error": null
}
```

The example shows one step for brevity. A passing result must include exactly all
declared steps, each passed with an existing screenshot, plus an existing trace,
build identity and environment. Duplicate or unknown step IDs are rejected.
Evidence references must resolve inside that run's directory and exist on disk.
Failed results may have no evidence if the browser could not start. A failed
step's error is retained separately from the run-level error.

WriterApp runs include a frozen `target` profile. A successful completion must
match its `baseUrl` and `expectedBuildVersion`, and include `identity` with the
expected `userId`, created GUID `documentId`, `evidenceKind: "live-application"`
and observed `roles`. Profiles are local SQLite state; edits affect future runs.
Queueing and the worker both check the target before performing test actions.

## Feedback example

```json
{
  "stepId": "save",
  "comment": "After saving I cannot tell whether the document was saved.",
  "requestedOutcome": "Show a clear confirmation only when persistence succeeds."
}
```

Both text fields are required and limited to 8000 characters. The resulting
prompt includes the application, frozen test/step definition, run ID, build,
environment, fixture, automated outcome and screenshot/trace references. Paths
in the prompt are relative to `data/evidence/`; when handing a task to another
tool, supply the evidence root or attach the sanitized files explicitly.

The prompt is plain text for review. Comments and screenshots remain untrusted
task material when the Codex worker consumes them; they must not alter that
worker's permission policy or repository configuration.

## Improvement jobs

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/api/jobs` | Public job records, newest first; no lease tokens. |
| POST | `/api/jobs` | Draft from `{ "runId": "...", "feedbackId": "..." }`. |
| GET | `/api/jobs/{id}` | Current job, source/build identities and rerun link. |
| POST | `/api/jobs/{id}/draft` | Save `{ "prompt": "...", "revision": 1 }`. |
| POST | `/api/jobs/{id}/start` | Explicitly queue the saved revision. |
| POST | `/api/jobs/{id}/cancel` | Request cancellation; cancel drafts/queued jobs immediately. |
| POST | `/api/worker/jobs/claim` | Oldest compatible queued job, original run and private lease, or 204. |
| POST | `/api/jobs/{id}/heartbeat` | Renew `{ "lease": "..." }`; returns cancellation state. |
| POST | `/api/jobs/{id}/report` | Append an event and advance a valid execution stage. |
| POST | `/api/jobs/{id}/rerun` | Create and claim the linked regression run atomically. |
| POST | `/api/jobs/{id}/finish` | Complete the job with a valid worker lease. |
| GET | `/api/jobs/{id}/events?after=0` | Up to 200 incremental events with monotonic cursors. |
| GET | `/api/jobs/{id}/artifacts/{file}` | Whitelisted local logs, diff or summary only. |

Draft prompts are required, limited to 24000 characters and normalized to LF.
Revision checks reject concurrent edits and repeated starts. Unsupported or dirty
source runs can retain drafts, but their `startBlocker` prevents implementation.
The original run, feedback and base source revision cannot be edited through a job.

Worker reports include `lease`, `stage`, `message` (up to 4000 characters) and
optional `worktreePath`, `threadId`, `resultCommit`, `buildVersion`, `summary`.
Thread/worktree and a distinct result commit are required before building. Recorded
identities cannot change mid-job. Leases expire in 45 seconds and are private to
the claiming worker; stale reports and late completions are rejected.

The rerun endpoint accepts `{ "lease": "...", "target": { ... }, "worker": { ... } }`. Its target
must describe the clean result commit and recorded build version at a separate
local instance. It returns a `RunLease` to the job worker and links both the parent
run and improvement job. The original manifest and test snapshot are preserved, and acceptance
starts pending. Successful job completion requires a passing linked rerun.

Job artifact names are limited to `codex.log`, `build.log`, `launch.log`, `diff.patch`,
`summary.json`, and `build-receipt.json`. Original feedback and run evidence remain
available separately.

## Operational routes (schema 4)

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/api/history?page=1&pageSize=20` | Run page with `items`, `total`, `page`, `pageSize`, `snapshot`; optional `test`, `application`, `status`, `acceptance`. |
| GET | `/api/job-history?page=1&pageSize=20` | Job page; optional application/status filters. |
| POST | `/api/runs/{id}/heartbeat` | Renew `{ "lease": "..." }` and return cancellation state. |
| POST | `/api/runs/{id}/cancel` | Cancel queued run or request running cancellation; linked runs use the owning job. |
| GET | `/api/runs/{id}/reviews?after=0` | Up to 50 immutable decision events, ascending sequence. |
| GET | `/api/maintenance/preview?days=30` | First batch of eligible evidence/worktree candidates; no mutation. |
| GET | `/api/maintenance/preview-page?days=30&page=1` | Candidate batch plus `hasMore`; scans at most 200 resources of each kind per page. |
| GET | `/api/maintenance/history?page=1` | Paged cleanup journal. |
| GET | `/api/maintenance/tasks` | Latest 100 cleanup tasks, without leases. |
| POST | `/api/maintenance/tasks` | Explicit `{ "kind": "evidence", "resourceId": "...", "token": "...", "retentionDays": 30 }` from a current preview. |
| POST | `/api/maintenance/tasks/{id}/cancel` | Cancel a queued removal before claim. |
| POST | `/api/worker/cleanup/claim` | Claim an explicitly queued removal or 204. |
| POST | `/api/maintenance/tasks/{id}/heartbeat` | Renew the private cleanup lease. |
| POST | `/api/maintenance/tasks/{id}/finish` | Acknowledge completed/failed/interrupted cleanup. |

History page sizes are 1–100. Pass the returned `snapshot` on subsequent run/job
page requests to exclude later inserts from that browsing session; omit it to
refresh. The recent `/api/jobs` endpoint is also capped at 100. Individual IDs
remain directly readable regardless of pagination.

Run completions accept passed, failed, interrupted and requested cancellation.
Requested cancellation wins over a late pass. Any expired lease rejects writes.
Retired evidence returns 404 while metadata, review events and feedback remain.
Worktree cleanup retains the branch and result commit. See [operations](operations.md)
for preview protection, process supervision and recovery details.
