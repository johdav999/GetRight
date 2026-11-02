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
