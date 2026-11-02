# Four implementation milestones

The local demo, SQLite history, evidence capture and task export are the completed
starter baseline. The four milestones below cover the remaining application.
Their GitHub definitions are kept in `config/milestones.json`.

| Milestone | Outcome | Status |
| --- | --- | --- |
| [1 — WriterApp UAT](https://github.com/johdav999/GetRight/milestone/1) | Five repeatable workflows against isolated WriterApp data, with build/account checks and reviewable evidence. | In progress |
| [2 — Feedback-to-fix cycle](https://github.com/johdav999/GetRight/milestone/2) | An editable task becomes a Codex worktree job, a verified build and a linked rerun. | Implemented and validated |
| [3 — Virtual Company UAT](https://github.com/johdav999/GetRight/milestone/3) | The selected business workflow uses dedicated company data and the same UAT cycle. | Planned |
| [4 — Operational polish and reliability](https://github.com/johdav999/GetRight/milestone/4) | Repeated cycles, cancellation, recovery, audit, cleanup and comparison work reliably. | Planned |

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

Choose the first business workflow with the user. Define its local host,
dedicated company fixture, identities, roles, observable outcome and cleanup.
Implement the adapter through the shared run/evidence contract and then exercise
the feedback-to-fix cycle. Expand to further workflows after the first is accepted.

Acceptance: the chosen business outcome is repeatable and isolated, evidence
identifies the running build and role, and a user can review the complete cycle.

## 4 — Operational polish and reliability

Extend heartbeat/cancellation and process supervision to standalone UAT runs; add review audit history,
pagination, evidence retention, before/after comparison and worktree cleanup.
Exercise failure and restart paths and polish the real user flows. Add remote
dashboard/worker authentication only if hosted operation becomes a requirement.

Acceptance: the local app handles repeated UAT cycles, interrupted work, failed
builds and cleanup without losing history or mixing acceptance between runs.
