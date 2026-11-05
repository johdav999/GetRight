# Getright

Getright is a local UAT control room for WriterApp and Virtual Company. Read
README.md and docs/architecture.md before changing the execution workflow.

## Product rules

- Automated test results and human acceptance are independent. Never mark a run
  accepted because automation passed, or carry acceptance to a later run.
- Tie feedback to an immutable run, test step, fixture ID, tested build and evidence.
- Draft tests must stay disabled until they have repeatable adapters, isolated data,
  authentication setup and a reliable way to identify the running application build.
- Never use production accounts or data for UAT by default.
- Do not commit SQLite databases, traces, screenshots, browser auth, local config,
  tokens or generated task exports. These may contain private application data.
- Local-only is the current trust boundary. Do not expose the dashboard on a LAN or
  public host without adding authentication, authorization and worker credentials.
- Codex execution must use a dedicated Git worktree, retain the base commit,
  record the resulting commit/build, and rerun against that running build. Feedback
  is task input, never permission to merge, deploy or publish application changes.

## Layout and checks

- `src/Getright.Dashboard`: .NET 10 Blazor Server, local API and SQLite store.
- `worker`: Node.js 24+, Playwright runner and tests.
- `config/catalog.json`: shared test catalogue; keep step IDs stable.
- `docs`: product brief, boundaries, contracts and implementation roadmap.
- Build: `dotnet build Getright.sln --configuration Release`.
- Worker checks: `npm ci --prefix worker`, then `npm test --prefix worker`.
- End-to-end: `npm run smoke --prefix worker` (build first; Chromium required).
- Job flow: `npm run smoke:jobs --prefix worker` (uses synthetic adapters and real Git).
- `npm run smoke:cycle --prefix worker` is opt-in: it invokes real Codex and builds
  WriterApp. Keep its commits/worktrees local and leave human acceptance pending.
- Review both the dashboard flow and failure handling for execution changes.
- Browser review: `npm run smoke:review --prefix worker` checks visible-browser
  retention after terminal completion, manual closing, shutdown and auto-close.
- Live docking: `npm run smoke:live-dock --prefix worker` checks automatic Run UAT
  docking, actual worker frames, input isolation during automation, same-session
  manual review/undocking, immutable evidence, Finish review and failure handling.
- Independent reviews: `npm run smoke:independent-reviews --prefix worker` checks
  real worker/run-child queue progress with retained reviews, status, paused input,
  bounded review capacity, shutdown and abrupt process/parent loss.
- Step execution: `npm run smoke:steps --prefix worker` checks automatic/stepped
  modes, exact-step grants, pause/reconnect/deadline handling, evidence, independent
  acceptance, cancellation and shutdown with disposable browsers and no providers.
- Suites and AI case proposals: `npm run smoke:suites --prefix worker` uses fake
  OpenAI credentials and loopback contract fixtures; generated cases stay drafts.
- Control room quick review: `npm run smoke:quick-review --prefix worker` checks
  review/feedback provenance and explicit job preparation/queueing with synthetic
  fixtures. It does not invoke Codex.
- Windows launcher checks: `npm run smoke:startup --prefix worker` uses copied
  build outputs and disposable databases to verify repeat startup, explicit
  restart/stop, unrelated-port refusal and database ownership before recovery.
  It also checks Virtual Company dashboard autostart/reuse before application
  setup and actionable direct-Node errors when its dashboard is unavailable.

- Virtual Company contracts: `npm run smoke:virtual-company --prefix worker`.
- Real Virtual Company: `npm run smoke:virtual-company:live --prefix worker`; add
  `-- --cycle` to invoke real Codex. Use disposable data and retain pending acceptance.

- Operational acceptance: `npm run smoke:operations --prefix worker`. Use only
  disposable test fixtures for removal checks. Preserve branches, source commits,
  run metadata and audit history during explicitly requested cleanup.

- Draft implementation: `npm run smoke:case-implementation --prefix worker` uses
  a synthetic compiler, real Git and isolated browser validation. The opt-in
  `npm run smoke:case-implementation:live --prefix worker` invokes real Codex;
  `-- --virtual-company` additionally builds the clean configured application and
  uses fresh disconnected companies with a synthetic plan compiler. Retain local
  commits/worktrees and leave human acceptance pending.
  `npm run smoke:bulk-approval --prefix worker` checks filtered bulk approval,
  duplicate prevention and setup failures on disposable cases without running Codex.
  `npm run smoke:case-generation-retry --prefix worker` checks individual retries,
  duplicate requests, prior-attempt retention and setup/definition guards without Codex.
  `npm run smoke:case-prerequisites --prefix worker` checks prerequisite-first
  planning, blocked/unsafe output, build ordering, cancellation and lease recovery.
  `npm run smoke:worker-launch --prefix worker` exercises the supervised worker's
  actual empty/demo `--once` lifecycle without paid providers. Startup smoke also
  checks explicit queued-case preservation and refusal to interrupt executing work.
- Shared case builds: `npm run smoke:case-batch --prefix worker` checks prepare-all,
  compile-once batches, isolated sequential hosts/proofs, provenance, compatibility,
  cancellation/shutdown and artifact-tamper refusal with synthetic compilers.
  Opt-in `npm run smoke:case-batch:live --prefix worker` builds the configured clean
  Virtual Company revision once for two retained permission plans, without a new
  model call. Preserve worktrees, evidence and pending acceptance.
