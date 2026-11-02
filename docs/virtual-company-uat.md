# Virtual Company UAT

The first workflow creates a test company, saves draft-only email permissions,
and reopens its controls. It checks the actual owner membership, persisted
permissions, employee read/write denial, outsider denial, and an unchanged
reference company. The established catalogue ID is `virtual-company-workflow`;
its original `workflow` step ID is preserved.

## Start a local instance

Install the SDK required by the Virtual Company checkout (`global.json`, currently
.NET 9.0.317), Node 24+, and Getright's worker dependencies and Chromium. Start
Getright first, then run from the Getright repository:

```powershell
./scripts/start-virtual-company.ps1
```

The launcher reads the trusted `virtual-company.repositoryPath` in
`config/worker.local.json`, defaulting to `../Virtual Company`. See
`config/worker.example.json`. It creates a fresh detached worktree at that repo's
committed HEAD, builds the actual Web/API projects and the Getright-owned harness,
and launches owned loopback processes. Uncommitted sibling changes are excluded.
Historical artifacts and application data are excluded from the source checkout
to avoid Windows path limits and reuse of existing data. Build logs and a launch
receipt are kept under `data/virtual-company/<instance-id>/`.

The launcher saves its receipt to the running dashboard. Use `-DashboardUrl` for
a different loopback dashboard origin. Open **Application setup**, select
**Virtual Company**, and check the connection. The receipt records the unique
build version, actual user ID, reference company ID, owner role, clean source
commit and Web assembly SHA-256. Setup fields can also be entered manually.

Run **Create a test company and save permissions** in the control room. Review
the four step screenshots and trace. Feedback can prepare an editable task;
**Implement improvement** explicitly starts its Codex job. The worker uses the
Virtual Company repository and fixed build/launch adapter, creates a separate
branch at the tested commit, builds the change, and reruns the frozen workflow
with fresh data. The resulting run always awaits human acceptance.

Ctrl+C stops the launcher's owned processes. Each job stops its changed host
after its regression run. Databases are in memory and are discarded on shutdown;
screenshots, traces, receipts, logs, worktrees and local commits remain for review.
Retained worktree removal and evidence retention are milestone 4 work.

## Product profile and fixture boundary

| Item | Contract |
| --- | --- |
| Surface | Actual Blazor Server Web UI and composed API/business services |
| Database | Fresh SQLite in-memory database from Virtual Company's test factory; survives browser reload within that host only |
| Owner | Development subject `getright-owner`, synthetic `.invalid` email, generated actual user ID |
| Employee | `getright-employee`, employee membership in the reference and newly created company |
| Outsider | `getright-outsider`, no membership in the created company |
| Reference company | `04040404-0404-0404-0404-040404040404`, seeded independently; its access identity is read before/after |
| Created company | Unique name containing the immutable run fixture ID; actual company ID retained with run evidence |
| Mailbox prerequisite | Disconnected Standard Email fixture record, `.invalid` address, send-capability metadata, no credentials or transport invocation |
| Mutation | Company creation and policy saving through the real UI; only prerequisite mailbox/membership records are fixture setup |
| Expected outcome | Only `email.draft`, exact approved recipient and sender; send permission disabled; reopening retains them; employee writes/read and outsider read are rejected |
| Cleanup | Owned processes stop, in-memory companies disappear; review artifacts stay local |

The API test factory disables hosted background services and uses its established
test substitutes for provider/document/tool boundaries. This validates the real
company creation, policy persistence and authorization services against SQLite.
It does not establish production SQL Server compatibility, external authentication,
provider drafts, email delivery, financial posting, or process-restart persistence.
No accounting workflow is executed and no production credentials are loaded.

## Build and runtime attribution

Virtual Company's Web UI has no native build-version endpoint. The UAT harness
therefore exposes `/_getright/runtime` through an owned loopback gateway. It reads
the loaded API assembly version, checks the harness and compiled Web assembly
versions, and resolves the owner's actual membership through `/api/auth/me`.
The gateway checks owned process liveness and the compiled Web DLL hash before
returning runtime identity. Both Web and API are built with the same unique
assembly version from a recorded clean commit. This is local launcher attribution,
not a production attestation protocol.

Getright freezes the version, user, role, reference company and source receipt in
each run. It checks them before queueing and again before/after browser actions.
The adapter additionally reads the actual API membership. A passing completion
requires a separate created company ID and the matching reference company/role.
Feedback exports retain both company identities. Existing schema-3 records remain
compatible because the added profile/identity properties are optional JSON fields.

## Verification

```powershell
npm test --prefix worker
npm run smoke:virtual-company --prefix worker
npm run smoke:virtual-company:live --prefix worker
npm run smoke:virtual-company:live --prefix worker -- --cycle
```

The contract test uses a clearly labelled synthetic runtime and placeholder files
to check Getright's validation and setup UI; CI runs it without Virtual Company.
The live test builds Virtual Company and uses its real UI/API. `--cycle` also invokes
the real Codex SDK using the local sign-in, retains its thread/result commit, and
repeats the original workflow. It performs an additional visible check of the
requested copy change. It creates no merge, deployment or human acceptance.
Local evidence and the issue ledger are in `.local/vc-live-<timestamp>/cycle-report.json`.

The live profile covers creation, permission saving, reopening and access denial.
Further business workflows should be selected after reviewing this first flow.

## Recorded live validation — 2026-11-02

The real Codex cycle is retained locally in
`.local/vc-live-1793606584958/cycle-report.json`:

- Original clean source: `e7840fadd8a425e254ed7671291cc14c469b4ff0`.
- Original passing run: `0a99cc2cb13547b3b305a35386d7b79c`.
- Codex job: `d3d31fe18e7d4ed4bd77b0a4d7a8befb`.
- Real Codex thread: `01a19b48-d610-7e61-9b0b-6dad4d7ac5d0`.
- Local result commit: `b060d66b68ade5c4891da0c1e73b14f50690580f`.
- Changed runtime: `0.2.54227.8161`.
- Passing linked run: `e52c8995505d435a98114dfd84d808d8`, acceptance pending.

Issue `VC-UAT-001` (P3 clarity enhancement) changed the English creation description
to distinguish an empty company from the later population action. The original
flow, actual role/company checks and visible revised copy passed. Desktop and
390px mobile evidence were inspected. This code change remains on the local
Virtual Company worktree branch for review; it was not merged or published.
The existing Virtual Company build emitted dependency/nullability warnings;
Getright's own release build is checked with warnings as errors.

The user-facing launcher was also exercised with a clean source checkout: it
built the real applications, imported its receipt, passed readiness and shut down
its owned process tree and gateway. Builds run one project at a time to limit
compiler memory use on the large migration projects.

To review this recorded cycle in the dashboard, use its retained data directory:

```powershell
$env:Getright__DataPath = (Resolve-Path .local/vc-live-1793606584958).Path
./scripts/start-dashboard.ps1 -NoBuild
```

Then open `/jobs/d3d31fe18e7d4ed4bd77b0a4d7a8befb` on the dashboard's local origin.
This reopens stored evidence; the disposable application instances have stopped.
Remove that environment override before starting the dashboard with normal data.
