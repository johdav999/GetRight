# Live browser docking

**Run UAT test** in the control room and **Run again** on a run page request
`docked: true` when queueing the run. They open `/runs/{id}/watch` immediately,
including while the run waits for a worker. This page shows the live viewer
beside the frozen test case and its human acceptance panel. Normal API clients omit this optional
flag to retain the previous standalone browser behavior. Existing stored runs
default to `false`; no database schema migration is required.

This panel shows the actual worker browser, rather than opening another app
session in an iframe. The worker launches Chromium headlessly with the normal
isolated context, build checks, steps and evidence capture. It uses a
[Playwright CDP session](https://playwright.dev/docs/api/class-cdpsession) and
[Chromium page screencasting](https://chromedevtools.github.io/devtools-protocol/tot/Page/)
over its owned browser pipe. No debugging port or inbound worker listener is opened.

## Review lifecycle

The viewer starts with a compact status row and collapsed **Controls & status**
drawer. Next step remains directly reachable. Finish review, navigation, full
status/step instructions and remaining-step/cancel actions live inside
the drawer, which scrolls within a bounded height. General session explanations
and interaction reminders are omitted from the dock. Errors remain visible outside
it. Keyboard input into the focused app works with the drawer closed; Shift+Escape
returns focus to an available dock control. The client can upgrade the previous
viewer markup without restarting its dashboard or worker browser.

Standalone docked runs support optional `stepByStep: true` alongside `docked:
true`. The initial mode is frozen in the run snapshot; old records default to
automatic execution. A worker must advertise `supportsStepControl: true` when
claiming stepped runs, so an older worker cannot execute all their steps at once.

In step mode, trusted runtime/fixture setup completes first. Before every frozen
test step the worker reports a pause and waits for **Run next step**. Each released
step executes all its actions and assertions in order, captures its screenshot,
then pauses before the next step. **Run remaining steps** releases the current
step and continues the rest automatically in the same browser/context/fixture.
Both modes stop on failure and keep human acceptance independent.

The dock reports the exact step number/title and reconnects to the same pause
after navigation, reload or undocking. Click, scroll and type into the tested app
while paused. **Run next step** still executes the step's automated actions and
assertions; it does not simply mark a manually performed step as passed. Input
locks immediately when continuing and unlocks at the next pause. The
worker's normal heartbeat remains active. Human waiting is excluded from the
active automation deadline but each pause expires after 15 minutes. Cancellation,
shutdown, lost ownership and dashboard restart still stop or interrupt execution.

The worker-only `/browser/step` endpoint requires its private session token and
reports `waiting` or `passed` against a frozen step ID. Public `/browser/advance`
requests target that exact ID. The session enforces ordering and consumes at most
one release for each step; duplicate clicks or stale tabs cannot release later
steps. This transient progress does not create passing results: ordinary step
assertions, evidence and terminal completion are still required. Job-owned
validation/regression runs remain automatic.

While automated actions execute, the viewer is read-only. Both server and worker enforce this.
Workers advertise paused-input support at connection. Accepted input is delivered
in acknowledged batches and drained before a step may execute. Input and release
share one worker execution lane; retried polls cannot replay an acknowledged batch.
Paused commands include the frozen step ID, rejecting input from stale tabs.
After tracing stops and the dashboard acknowledges a passed or failed result,
the same browser becomes available for clicks, scrolling, keyboard input and
bounded back/forward/reload actions. Click an app field to type or paste directly.
**Actual size** avoids shrinking the app on a small panel;
**Fit** shows its full viewport. Shift+Escape releases viewer keyboard focus.

Manual actions during pauses are part of the active trace and can affect later
assertions. The stored run lists assisted step IDs, shown in review and included
in feedback prompts; it is not an unattended result. Input contents are not stored
in metadata. Actions after completion are outside the recorded run. They cannot rewrite its screenshots,
trace, automated result or human acceptance. Accept/request-improvement actions
remain in the dashboard review panel and run detail page.

In a continuous worker, completed browsers are retained by independent owned run
processes. Their results release the main execution queue immediately, including
failed or timed-out tests with surviving browsers. **Finish review** closes just
that browser. A run paused before a step is still executing and waits for Continue,
Cancel or its 15-minute limit. **Worker activity** in the control room distinguishes
these states and lists open reviews with direct **Finish review** buttons.

Each worker retains the three newest completed browsers. A fourth closes the
oldest with a visible capacity reason. Saved screenshots, traces and acceptance
remain unchanged. Worker stop/source reload closes owned review processes; private
owner heartbeats supplement IPC ownership on Windows. Returning to the control room
leaves the run and browser session active. **Undock** opens `/runs/{id}/live`,
another viewer of the same browser session, and preserves its current navigation
and unsaved state. **Dock browser** restores the embedded viewer. The run details
page's **Watch test / continue review** link opens the dedicated run page. If another run
waits behind an earlier review, its viewer links to that review.

On wide screens the tested app stays in view while the reviewer scrolls through
the case and acceptance controls. Narrow screens place the app above the case
and review. The control room remains the place to browse suites and cases.

Explicit auto-close mode closes the browser after automation. Cancellation,
timeout, worker shutdown or sustained connection loss also release owned
resources. Failed runs can be reviewed if a browser page survived the failure.
Dashboard/worker restarts do not restore browser sessions; stored run evidence
and review history remain available. A closed viewer can retain its last frame,
clearly marked closed, until the bounded in-memory cache is pruned.

The separate **Open test page** feature still performs runtime preflight and
opens the configured application in an iframe without creating a run. Its
undocking opens a new entry-page tab, unlike live-run undocking.

## Transport boundary

All routes remain subject to the dashboard's loopback Host/peer and same-origin
checks. This is a trusted local-user tool, without remote hosting or multi-user
authentication.

- `POST /api/runs/{id}/browser/connect` requires the active private run lease and
  a standalone docked run. It issues a private session token, never included in
  public status, storage or logs.
- Worker `/frame`, `/poll` and `/end` calls require that session token. Polling
  supplies heartbeats and drains bounded commands in review or at step pauses.
- Public `GET /browser` reports phases and frame sequence; `GET /browser/frame`
  serves the latest JPEG with `Cache-Control: no-store`.
- `POST /browser/input` accepts only bounded coordinates, text, allowed keys and
  navigation actions at a step pause or after terminal completion. No script, selector, shell command
  or arbitrary navigation URL is accepted. `/browser/close` ends terminal review.

Frames are memory-only: at most 180 KB per JPEG and 32 sessions, with a 64-command
input queue. Heartbeat expiry marks disconnected sessions unavailable. Frames,
tokens and input contents are not appended to SQLite or task exports. Paused
interaction is included in the existing Playwright trace; assisted step IDs are
retained in run metadata. Post-completion review input remains outside evidence.

`npm run smoke:live-dock --prefix worker` verifies the actual UI/worker lifecycle,
frame transport, same-session interaction and undocking, input rejection during
automation, private credentials, origin checks, mobile layout, immutable evidence,
auto-close, shutdown and automation failure with disposable demo fixtures.

`npm run smoke:independent-reviews --prefix worker` runs the actual continuous
worker and separate browser processes. It checks queue progress while reviews
stay open, visible worker status, isolated paused input, review capacity, graceful
shutdown and abrupt process/parent loss against immutable disposable run evidence.

`npm run smoke:steps --prefix worker` checks step ordering, duplicate releases,
legacy-worker exclusion, reconnecting at a pause, active-deadline suspension,
remaining-step continuation, paused input and assisted attribution, acknowledged
input draining, automatic reruns, evidence/acceptance isolation,
mobile controls, pause expiry, cancellation and worker shutdown using real
disposable demo browsers.
