# API and runner contract

All routes are loopback-only. POST bodies are JSON, except the bodyless claim
route. Invalid workflow state and unknown identifiers return 400; unregistered
evidence and missing task exports return 404. Request bodies are limited to 256 KiB
to support bounded Unicode prompts; interactive messages are limited to 128 KiB.
No CORS policy is enabled.

Schema 5 also provides [suite, generated-case proposal and manual entry-page
contracts](test-suites.md#api). The catalogue includes persisted drafts; they stay
disabled for automation until execution support is implemented.

Schema 6 adds [explicit draft implementation and verification](test-implementation.md#api-and-recovery).
Normal worker claims may send `{ "workflowEngineDigest": "<sha256>" }` to declare
declarative workflow support. Bodyless/empty claims remain compatible with built-in
adapters and cannot accidentally take a declarative run. Verified implementations
are frozen in run snapshots, including plan/engine digests and source attribution.

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
| POST | `/api/worker/claim` | Oldest queued run with private lease, or 204. |
| POST | `/api/runs/{id}/complete` | Submit terminal automated result with valid lease. |
| POST | `/api/runs/{id}/review` | Set `{ "acceptance": "accepted" }`, pending or improvements-requested. |
| GET | `/api/runs/{id}/feedback` | Original comments and generated prompts. |
| POST | `/api/runs/{id}/feedback` | Create step-specific feedback and a task draft. |
| GET | `/api/runs/{id}/tasks/{feedbackId}` | Download the generated plain-text task. |
| GET | `/api/evidence/{id}/{file}` | Serve a referenced screenshot or trace only. |

## Completion example

Health also reports `instanceId`, `processId` and `dataPath` for local launcher
ownership checks. It includes no credentials. Database ownership is acquired
before RunStore recovery, independently of HTTP port ownership.

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
| POST | `/api/worker/jobs/claim` | Oldest queued job, original run and private lease, or 204. |
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

The rerun endpoint accepts `{ "lease": "...", "target": { ... } }`. Its target
must describe the clean result commit and recorded build version at a separate
local instance. It returns a `RunLease` to the job worker and links both the parent
run and improvement job. The original test snapshot is preserved and acceptance
starts pending. Successful job completion requires a passing linked rerun.

Artifact names are limited to `codex.log`, `build.log`, `launch.log`, `diff.patch`
and `summary.json`. Original feedback and run evidence remain available separately.

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
