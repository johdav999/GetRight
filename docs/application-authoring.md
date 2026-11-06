# Author an application integration

Getright can run a new local web application using a catalogue entry, a manifest
and a version 2 workflow. A trusted worker recipe is optional and enables the
feedback-to-build cycle. The Sample Notes definitions in `config/examples`
exercise this path with a real Node.js HTTP server and file-backed persistence.

## Register and qualify a target

1. Give the application a stable ID in `config/catalog.json`. Add its matching
   entry to `config/application-manifests.json` and copy both files into the
   dashboard output before starting it. For a new unscoped application, use
   `configured-v2` for `fixtureAdapter` and declare only the `configured-v2`
   adapter at version 2. A restart adds the default suite for a new application
   while retaining existing suite edits and run history.
2. Run a dedicated application instance on a loopback origin separate from the
   dashboard. Its primary test identity must return an HTTP 200 JSON receipt
   from `/_getright/runtime` with `version`, `userId` and `isolated: true`.
   Bind the exact values and the clean source commit in **Applications**.
   **Check connection** verifies the receipt and declared fixture capability.
3. When the workflow needs setup and teardown, implement the owned fixture
   routes described in [runtime plans](architecture.md#runtime-plans). Return a
   UUID and the requested fixture ID on creation. A worker verifies ownership
   again before deletion and records cleanup failures in the run.
4. Import the workflow JSON from **Applications**. Give every stable step an
   observable assertion. Prefer a UI write followed by an independent backend
   read and a reload. Keep selectors and paths local and use generated fixture
   values for data. An observed response can capture up to four typed values.
   Text captures can be compared or used in browser fields, while only
   path-safe captures can be interpolated into URLs.
5. Record two consecutive passing qualification runs for the saved workflow,
   manifest and binding. Inspect the screenshots, trace, API observations,
   resources and cleanup results. Human acceptance is a separate decision.

## Enable improvement jobs

Use `capabilities: ["test", "implement"]` and a versioned `buildRecipe`
reference only when the local worker has an authorized recipe for that
application. Copy the shape of `config/examples/notes-recipe.json` into
`recipes` in the trusted worker configuration. Key it by the recipe ID and
set `repositoryPath` to the application Git root. Use a separate local
`worktreeRoot`. The build must emit the assigned build version and commit,
and the readiness endpoint must report both with the dedicated account and
isolation flag.

The dashboard exposes recipe IDs and versions. It validates the reference
while the worker authorizes and executes the local build and launch
specification. Workflow JSON and feedback cannot supply executables,
repositories, scripts or command arguments. The changed build runs with
new data in a worker-owned host. Its regression uses the original frozen
manifest and workflow and starts with pending acceptance.

## Capabilities and extensions

| Application | Shared workflow execution | Registered extension |
| --- | --- | --- |
| Getright demo | Browser fill, save, reload, assertions and evidence | Dashboard-local static fixture with browser storage and restricted navigation |
| WriterApp | Browser document creation, save, reload, correlated ID and title capture, and independent persistence reads | Dedicated development identity checks, bounded onboarding and Documents-tab readiness, .NET build and owned host |
| Virtual Company | Versioned sequence, step control, evidence, frozen runtime and company resource reporting | Owned API and Blazor host plus four company phases for reference comparison, disconnected fixtures, draft-only permissions and owner, employee and outsider authorization |
| Sample Notes | Generic runtime, provisioning, browser and API persistence, teardown, and configured build and rerun | No app-specific Getright extension |

The generic target supports an unscoped primary account and the bounded runtime
and workflow operations in the manifest. Scoped memberships, custom provider
authentication, arbitrary script execution, outbound requests, and application
build systems outside the approved recipe types require a reviewed extension.
Generated version 1 test implementations still use the existing registered
fixture capabilities.

## Migration and rollback

Upgrade the dashboard and worker together. The worker advertises
`integrationContractVersion: 1` for version 2 claims. Existing test IDs, step
IDs, suite membership and saved bindings carry forward. Old snapshots retain
their original adapters and engine attribution. The legacy runner remains
available for earlier snapshots and verified version 1 cases.

For a catalogue-only rollback, stop the dashboard and worker after owned work
finishes, restore the prior matching catalogue and manifest entries, and start
the current binaries. New runs use the restored definitions. Keep the current
binaries available to service already-frozen version 2 runs and use the
retained database and evidence directory for historical review. Cancel obsolete
queued runs explicitly if you intend to replace them with new runs. A prior
binary may not understand newly added workflow actions. Keep a pre-upgrade
data backup if rolling back binaries is required.

## Verification

Run `npm run smoke:integration-migration --prefix worker` after building
Getright. It onboards Sample Notes by changing JSON in a copied dashboard
output and importing its workflow into an existing database. It verifies the
same dashboard binary before and after onboarding. Only the implementation
edit is synthetic. Chromium, the backend, Git, build, owned hosts and regression
are real and disposable.

`npm run smoke:integration-migration:live --prefix worker` explicitly opts in
to a real Codex SDK implementation on the disposable sample. It requires a
working local Codex sign-in. Evidence and local worktree commits stay in the
test directory. Live WriterApp and Virtual Company verification use their own
isolated launchers and evidence.
