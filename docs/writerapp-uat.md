# Milestone 1: WriterApp UAT

## Current implementation

The first slice includes local setup, runtime preflight, a frozen run target,
an isolated launcher, and the real create/save/reopen adapter. The other four
WriterApp workflows remain drafts. Milestone 1 is not complete.

## Start an isolated instance

From Getright in a separate PowerShell terminal:

```powershell
.\scripts\start-writerapp.ps1 -Port 5401
```

Use `-RepositoryPath <checkout>` if WriterApp is not in the sibling folder. The
script builds that checkout into new `artifacts/getright/<instance-id>` directories
within each project. It never edits WriterApp source or its normal configuration.
The instance uses its own content root, database and config under Getright's
ignored `data/writerapp/<instance-id>` folder. A copied client index and the build's
static-assets manifest serve the actual WriterApp client.

The script injects a distinct assembly version, disables AI and billing in the
isolated config, and prints the URL, version, account ID and build-receipt path.
The receipt records the source commit and whether local changes were present.
The launcher does not commit, reset or clean the WriterApp checkout. It also pins
the database and feature flags in the child environment, so inherited machine
settings cannot select the normal database or enable AI, billing or collaboration.

WriterApp's Development handler currently fixes its identity to `dev-oid` with
the Admin role. Each launch gets a new database, making this an isolated test
identity within that instance. This is not external-authentication or multi-user
acceptance. Sharing will require separate real identities in a later M1 slice.

## Configure and run

Start the Getright dashboard and worker as described in README.md. Open
**Application setup**, enter the printed URL/version/account, confirm isolation
and select **Check connection**. Then return to the control room and run WriterApp's
**Create and save a document** test.

To also retain source-receipt metadata in the local profile, import it via the API:

```powershell
$receiptPath = '<absolute path printed by the launcher>/build-receipt.json'
Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:5120/api/applications/writerapp/profile' `
  -ContentType 'application/json' -Body (Get-Content -LiteralPath $receiptPath -Raw)
```

The profile stores no password, token or browser session. The current adapter
requires an instance with automatic isolated test sign-in; importing browser
sessions for other accounts is future work. Editing the profile in the UI clears
optional source-receipt metadata so it cannot be attributed to an unrelated build.

## What the test does

1. Verify runtime version and account. Complete onboarding for the isolated account
   through WriterApp's setup API, then open the actual document library.
2. Create a document through the UI. Record its returned document/section IDs and
   original title, then type a unique fixture marker in the actual editor.
3. Use Document actions → Save now. Poll WriterApp's page API until the marker is
   persisted, and confirm it is still visible in the editor.
4. Reload, check the editor content, and read the document/page APIs again to
   verify that the original title and saved text survived. Recheck build/account.

The adapter does not replace application API responses. Account onboarding is
fixture setup; document creation and editing go through the UI. It preserves the
initial document title instead of testing a separate rename workflow. Documents
remain in the isolated database for inspection. The worker captures each step
and its trace and leaves user acceptance pending.

Queueing and execution both reject wrong build/account identities. A queued run
uses its frozen target even if application setup changes later. Browser navigation
to other origins is blocked for this local adapter. This is a dedicated instance
contract, not a way to run UAT against production data.

## Validation

```powershell
npm test --prefix worker
npm run smoke --prefix worker
npm run smoke:writerapp --prefix worker -- '<absolute build-receipt.json path>'
```

The ordinary smoke test uses a clearly labelled synthetic WriterApp-shaped host
to verify Getright's adapter/configuration contracts and failure paths. It also
checks the database upgrade from schema 1. It does not establish WriterApp UAT.

The opt-in live check requires the actual isolated WriterApp host, creates its
own temporary Getright dashboard, and writes a report/evidence in
`.local/writerapp-live-*`. It leaves the WriterApp host running for inspection;
stop its foreground terminal with Ctrl+C when finished. No evidence is committed.

Live validation on 2026-11-02 passed create/save/reload and backend readback using
build `0.1.2497.57729` and a fresh launcher build `0.1.2497.52080`, based on WriterApp source revision
`0d204d7fea55f673dee35d7b9e90a6d78da297f9` with existing local changes. The account
was the isolated Development `dev-oid`/Admin identity. Human acceptance, the other
four workflows, external identity providers and real collaboration remain unverified.
The upstream WriterApp build reported existing dependency-audit warnings; Getright
did not change those dependencies as part of this integration slice.

A further fresh build, `0.1.2497.7945`, passed with deliberately conflicting
inherited database/AI/billing settings. The launcher used its isolated SQLite
database, kept AI disabled, and completed the same live persistence workflow.
