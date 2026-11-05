# Test suites, proposals and manual entry pages

A suite belongs to one application and contains stable test case IDs. Schema 5
seeds one suite for each existing application without changing catalogue IDs or
run payloads. Suite edits are revision-checked; membership changes do not alter
historical run snapshots. A suite may start empty, then gain existing or generated
cases. Cases may be included in more than one suite for the same application.

The control room filters by application and suite. Selecting an application or
suite also selects a visible case, keeping its detail and history consistent.
The suite page supports creation, membership editing and feature-based generation.
Use `/?suite=<suite-id>` to open the control room directly in one suite. Keep
unsupported future scenarios in a separate backlog suite while using a supported
suite for current UAT; moving suite membership preserves cases and run history.

## Open test page

The action next to **Run UAT test** opens a half-window panel without queueing automation;
**Undock** opens the page in a standalone tab.
It is also available at the top of each run-review page. That action opens the
currently configured running build's entry page; the historical run and acceptance
remain unchanged.
Its server route checks the current configured build, UAT identity and isolation,
then redirects to the fixed adapter entry route:

| Adapter | Entry route |
| --- | --- |
| Getright note | `/uat-fixture.html?fixture=uat-<new-guid>` |
| WriterApp create/save | `/app/documents` |
| Virtual Company setup | `/test-companies/new` |
| Verified declarative workflow | Its committed, relative `reviewPath` |

The demo gets a new local-storage fixture on each opening. Real app entry checks
are read-only. Navigation may use the target app's normal sign-in/onboarding
behavior; Getright does not perform fixture setup or create resources in this
action. The configured isolated host must already be running. Draft/unknown cases,
missing profiles and readiness mismatches produce an actionable error page with
links back to setup and the control room. API input cannot supply a redirect URL.
This opens the configured running build, not a stopped job's changed host.

## OpenAI generation

Configure `OPENAI_API_KEY` or `Getright__OpenAI__ApiKey` in the dashboard server's
environment. Do not put keys in tracked appsettings or suite data. Optional server
settings: `Getright__OpenAI__Model` (default `gpt-6-astra`) and
`Getright__OpenAI__TimeoutSeconds` (1–180, default 90). No key reaches the browser.

Only an explicit **Generate test cases** request calls OpenAI. Input consists of
the selected application name, suite name, feature description (up to 8000
characters) and requested count (1–10). Existing runs, evidence, repository files,
application auth and fixtures are excluded. The generation instructions request
synthetic fixtures, observable steps and explicit assumptions. No tools execute.

The [Responses structured-output contract](https://developers.openai.com/api/docs/guides/structured-outputs)
uses `text.format` with strict JSON Schema, bounded arrays and strings,
`store: false`, and a 12000-token output limit. The server additionally validates
the output, exact case count, distinct titles, required fields and step limits.
Refusals, incomplete responses, invalid output, rate limits, authorization failures
and timeouts create no proposal or case. No automatic retry may duplicate cost.
One generation at a time is allowed per dashboard process. The UI can cancel a
pending request; a cancelled call does not save a proposal.

A successful proposal records feature input, model, OpenAI response ID, creation
time and original cases. Reviewers may edit and select cases before applying it.
Apply writes case definitions, stable step IDs, suite membership and proposal
completion atomically. Repeating the same apply is idempotent. Every new case is
forced to `draft` with `adapter: null`; generation cannot queue it, create a build,
accept a result or authorize implementation. Existing run feedback still attaches
to an immutable run and step and prepares its separate improvement prompt.

The API endpoint is fixed to `https://api.openai.com/v1/responses`. For automated
HTTP contract tests only, trusted local configuration can set
`Getright__OpenAI__Endpoint` to a loopback HTTP server. Use a fake key with that
fixture. No alternate internet host or redirect is followed.

## API

| Method | Route | Behavior |
| --- | --- | --- |
| GET | `/tests/{caseId}/open` | No-store validated redirect or a recovery page |
| GET | `/api/suites` | List suites and their case IDs |
| POST | `/api/suites` | Create with applicationId, name, description and testIds |
| GET | `/api/suites/{id}` | Read one suite |
| POST | `/api/suites/{id}` | Save revision, name, description and testIds |
| GET | `/api/generation/status` | Configured flag and model; never the key |
| POST | `/api/suites/{id}/generate` | Generate a proposal from feature and count |
| GET | `/api/suites/{id}/proposals` | Latest 20 proposals including applied records |
| POST | `/api/suites/{id}/proposals/{proposalId}/apply` | Add the reviewed cases array as drafts |

`GET /api/catalog` includes both built-in cases and persisted drafts. Existing
queue routes resolve both but reject unimplemented drafts. Suite descriptions,
proposals and draft cases remain in the ignored local SQLite database.

## Verification

`npm run smoke:suites --prefix worker` exercises schema-4 migration, retained run
metadata, suite creation/membership, entry-page navigation, build mismatch recovery,
editable proposal selection, draft execution refusal, idempotent apply, provider
failure/refusal/truncation/invalid-output/timeout, concurrency, restart persistence
and desktop/mobile UI. It uses a clearly synthetic OpenAI HTTP contract and target
page. It never calls a paid provider. The normal smoke suites cover older schema
migration and the existing execution/review workflow.

## Recorded local validation — 2026-11-02

- Full suite/HTTP/browser contract: `.local/suites-1793619026024/suites-report.json`.
- Actual OpenAI Responses generation: model `gpt-6-astra`, response
  `resp_0792ddcd02aec6a6016ae873ead7a487d28de5edd1f7356d10`. Two synthetic permission
  cases were generated and saved as disabled drafts in a disposable dashboard;
  `.local/suites-openai-live-1793618930937/live-report.json` retains the result.
- Actual Virtual Company entry page: `.local/open-page-live-1793619042349/open-report.json`.
  The configured isolated build `0.2.60706.52280` opened in a new tab at
  `/test-companies/new`. No company or UAT run was created by the action.
- Existing dashboard/feedback, improvement-job, Virtual Company contract and
  operational-recovery suites passed against the new schema. Existing user data
  was not used for migration/removal checks.

The desktop/mobile review found and fixed suite dropdown label drift and fast form
editing that could lose an uncommitted description. Regression checks assert the
selected suite label and saved edited case definitions. All generated cases remain
drafts; these checks do not establish adapters for the generated scenarios.

## Approve and implement a draft

Select **Review draft** in the control room, then **Approve and implement test
case** above Workflow detail. This explicitly authorizes Codex implementation of
the frozen description. It does not accept an application run. The current worker
must be running; restart a worker that predates this feature.

The worker creates a dedicated Git worktree, commits a bounded workflow and runs
two validations with separate fixtures. A verified binding makes the case runnable;
failures retain the disabled draft, error, logs and evidence. Unsupported fixture
requirements are reported instead of replaced by weaker assertions. General
invoice ingestion, external providers and multi-user authentication fixtures are
not supplied by the current engine. See [test implementation](test-implementation.md)
for capabilities, provenance, APIs and verification scope.
