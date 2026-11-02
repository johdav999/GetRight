# Local operations and recovery

Milestone 4 keeps Getright local to one trusted user. It adds run cancellation,
heartbeat recovery, review audit history, paged browsing, run comparison and
explicit storage cleanup. Remote authentication is not part of this deployment.

## Run control

Open a run to see live results, **Cancel run**, or **Run again** after completion.
A new run gets a new fixture and pending acceptance. Run again uses the current
catalogue and application setup; an improvement job's regression run uses its
original frozen test snapshot. Cancel a linked regression through its owning job.

Queued runs cancel immediately. Running cancellation is acknowledged by the
worker heartbeat, normally within five seconds, and closes its browser. A late
passing result cannot overwrite a requested cancellation. Partial evidence is
retained when available; interruption never fabricates passing steps.

All claimed runs now have a private 45-second renewable lease. The dashboard
sweeps expired run, job and cleanup leases every five seconds, even with no open
browser page. Expired workers and late completions cannot reclaim ownership.
A dashboard restart immediately interrupts running operations; queued work stays
queued. Ctrl+C interrupts the worker's current operation and acknowledges it when
the dashboard is reachable. If communication is lost, lease expiry is authoritative.

The standalone browser deadline defaults to three minutes. Set
`GETRIGHT_RUN_TIMEOUT_MS` from 1000 to 600000 milliseconds before starting the
worker to change it. Job Codex/build deadlines remain separately bounded.
No automatic test retry is performed against possibly changed application data.

Fixed Git, build and application commands run under a small separate process
owner. If the worker dies without executing its `finally` block, the IPC channel
closes and the owner stops the child it spawned. Normal cancellation stops owned
process trees; unrelated processes and existing application instances are untouched.
Playwright browsers close on run cancellation, deadline or lease loss. An OS or
machine crash still relies on normal OS shutdown and durable lease recovery.

## Review and comparison

**Run history** offers application, result and acceptance filters, 20 records per
page, and comparison of two runs of the same test. Paging keeps a row-ID snapshot
so new runs do not shift the current selection; Refresh starts a new snapshot.
Improvement jobs are also paged. Home shows the latest 12 runs per configured test,
and labels its totals as recent rather than pretending they cover all history.

**Compare runs** displays each build, source commit, result, independent acceptance
and step screenshot. Missing, retired or unmatched evidence is shown explicitly.
The existing improvement-job comparison remains available as well.

Review decisions and feedback-induced decision changes append audit events in the
same transaction as the new acceptance. Events retain sequence, UTC time, action,
previous/new acceptance and feedback ID. They are attributed to this trusted local
reviewer, not an external identity. Earlier decisions are not reconstructed during
migration. Audit history loads in cursor-based batches of 50 events.

## Storage cleanup

Open **Local storage**, choose a retention period (default 30 days), and select
**Preview cleanup**. Previewing changes no files. Select one resource, inspect the
confirmation, then **Queue removal**. A queued removal can be cancelled before
the worker claims it. The cleanup journal records queued, running, completed,
failed, cancelled and interrupted operations and is paged. Preview batches are
paged too, including batches containing only protected resources.

Evidence is eligible only for completed, accepted runs older than the retention
period. Pending reviews and draft/queued/active improvement jobs protect their
source evidence. The preview token is rechecked when queueing; it is a stale-state
check, not authentication. Review and feedback changes are blocked while that
run's evidence removal is queued or running.

When claimed, evidence is marked retired before deletion. Its routes then return
404, while run results, immutable test/build identities, feedback, task prompts and
review audit remain in SQLite. The worker verifies the exact run directory,
refuses redirects/links, and checks every file against the run's registered
screenshots and trace before deleting anything. It performs no recursive evidence
delete. Unregistered files or directories cause a visible failure.

If cleanup stops part-way through, its journal becomes interrupted and the
evidence stays retired. Preview and explicitly retry to remove the remaining
registered files. If all files disappeared before the completion acknowledgement,
the same retry reconciles the journal. Unknown files require manual inspection;
the worker will not erase them to make a retry pass.

Worktree cleanup covers recorded improvement-job worktrees under the configured
worker worktree root. Successful jobs require human acceptance of their rerun;
all jobs must have been stopped for at least two minutes. Failed, cancelled or
interrupted jobs can qualify, but the worker still requires the expected registered
path, job branch, recorded commit and a clean Git status including untracked files.
Modified, moved or unrelated worktrees are refused. Git removes the one clean
worktree without `--force`; ignored build/test output inside it is removed too.
The local branch, result commit, logs, diff, job record and run history remain.

Detached baseline checkouts from the Virtual Company launcher and historical
unregistered worktrees remain for manual review through Git. They are not inferred
from arbitrary folders or deleted by this page. No branch deletion, repository-wide
prune, automatic scheduled purge, or cleanup of normal target-app data is performed.

## Persistence and verification

Schema 4 transactionally upgrades schemas 1–3, adding run lease expiry,
`review_events` and `cleanup_tasks`. Existing payloads and acceptance values remain;
new optional run/job fields mark cancellation and retired evidence/worktrees.
Older dashboard binaries refuse this newer schema. Keep database backups with the
matching evidence directory when preserving a review session.

```powershell
dotnet build Getright.sln --configuration Release --no-restore --warnaserror
npm test --prefix worker
npm run smoke --prefix worker
npm run smoke:jobs --prefix worker
npm run smoke:virtual-company --prefix worker
npm run smoke:operations --prefix worker
```

The operational suite uses the actual dashboard, Chromium, SQLite and Git. Its
five flows cover run control/review, browser interruption, history/comparison,
retention/recovery and worktree cleanup. Application implementation/build adapters
in the cleanup contract are explicitly synthetic; no paid Codex call or production
application data is used. It tests migrations, wrong/stale leases, shutdown and
restart, changing history during pagination, protected resources, partial cleanup,
unrelated-directory/link refusal, dirty worktrees, preserved commits, and desktop
and 390px layouts. Process tests kill a worker without its cleanup handler and
verify that the owned child exits.

Local screenshots and the issue ledger are stored in
`.local/operations-<timestamp>/operations-report.json`. `OPS-UAT-001` recorded and
verified the fix for pagination clicks arriving before Blazor interactivity.
`OPS-UAT-002` verified repeated run/build labels on stacked comparison images and
summary spacing against the desktop and mobile captures.

## Recorded validation — 2026-11-02

The completed operational session is in
`.local/operations-1793609560307/operations-report.json`; all five flows passed.
The live Virtual Company check is in
`.local/vc-live-1793609547531/cycle-report.json` and kept application acceptance
pending. Final comparison layout captures are retained in
`.local/operations-visual-1793609798363/`. These local artifacts are ignored by Git.

CI and `global.json` pin SDK 10.0.400 because SDK patch changes can change the
implicit ASP.NET asset package and invalidate locked restore. Upgrade the SDK
and regenerate/review its lock file together, then run the full suite.
