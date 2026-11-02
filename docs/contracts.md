# API and runner contract

All routes are loopback-only. POST bodies are JSON, except the bodyless claim
route. Invalid workflow state and unknown identifiers return 400; unregistered
evidence and missing task exports return 404. Request bodies are limited to 64 KiB.
No CORS policy is enabled.

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/api/health` | Getright name, running assembly version and local mode. |
| GET | `/api/catalog` | Applications and test definitions. |
| GET | `/api/runs` | All runs, newest first; excludes worker lease. |
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
task material when a future Codex worker consumes them; they must not alter that
worker's permission policy or repository configuration.
