# Implementation roadmap

## M0 — Local foundation (included)

- Blazor control room and run review.
- SQLite test snapshots, automated results, acceptance and feedback.
- Local Playwright worker, claim leases and restart interruption.
- Four-step isolated demo, screenshots and trace.
- Evidence-linked task export, five WriterApp drafts and a Virtual Company draft.
- Windows build and browser smoke checks in CI.

## M1 — WriterApp adapter

1. Configure the repository, local server/client URLs and approved build/start
   commands outside the test API. Keep machine paths in ignored local config.
2. Provision a dedicated workspace and UAT identities. Isolate account state for
   each browser, and keep Playwright auth state out of Git.
3. Establish an application-reported build identity and ensure fixture UI checks
   are explicitly distinguished from real persistence and collaboration checks.
4. Implement create/save/reload against the actual WriterApp UI and data store.
5. Adapt synopsis, edit/reopen, sharing and failed-save recovery one by one.

Reference starting points in the sibling checkout: `Tests/sharing-workspace.mjs`
and `docs/writing-tools-redesign-uat.md`. Inspect the current source before
adapting selectors. Do not copy a fixture script into Getright and label it live
application acceptance. No source changes to WriterApp are part of M0.

Done when all five tests are repeatable and each run records login role, isolated
data, actual running build and evidence. A user can watch and review each test.

## M2 — One feedback-to-fix cycle

1. Persist an editable improvement job linked to the original feedback/run.
2. Explicitly start the job in a new Git worktree on the configured repository.
3. Integrate the Codex SDK and stream progress/errors; retain thread and job IDs.
4. Build the changed version with bounded commands and captured logs.
5. Launch it on a separate port and require runtime identity to match the build.
6. Rerun the original test with new data; connect original run → feedback → job →
   resulting commit/build → rerun. Present old/new evidence for fresh acceptance.

Done when one real WriterApp improvement completes this cycle. Include failure,
cancellation, worker restart and cleanup paths. No automatic merge or deployment.

## M3 — Virtual Company

Choose the first business workflow with the user. Define the local host, dedicated
company fixture, identity/roles, observable business outcome and cleanup. Implement
it through the same test/run/evidence contract, then expand to more workflows.

## M4 — Operational features

Worker heartbeat/cancellation, review audit log, run pagination, evidence retention,
before/after comparison, repository worktree cleanup, and authenticated remote
dashboard/worker transport if centrally hosted operation becomes a requirement.
