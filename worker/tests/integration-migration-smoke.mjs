import assert from 'node:assert/strict';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { api, repositoryRoot } from '../src/settings.mjs';
import { boundedLog, runCommand } from '../src/processes.mjs';
import { executeJob, jobConfiguration } from '../src/jobs.mjs';
import { executeRun, workerClaim } from '../src/run-execution.mjs';
import { dashboardHost } from './dashboard-host.mjs';

const live = process.argv.includes('--live');
const dataPath = path.join(repositoryRoot, '.local', `m10-${randomUUID().slice(0, 8)}`);
const configPath = path.join(dataPath, 'worker.local.json');
const dashboardDll = process.env.GETRIGHT_DASHBOARD_DLL ||
  path.join(repositoryRoot, 'src/Getright.Dashboard/bin/Release/net10.0/Getright.Dashboard.dll');
const buildPath = path.join(dataPath, 'dashboard');
const copiedDll = path.join(buildPath, path.basename(dashboardDll));
const fixture = path.join(dataPath, 'notes-source');
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const example = name => json(path.join(repositoryRoot, 'config/examples', `notes-${name}.json`));
const [app, manifest, workflow, recipe] = await Promise.all(['application', 'manifest', 'workflow', 'recipe'].map(example));
const appRoute = `/api/applications/${app.id}`;
const testRoute = `/api/tests/${workflow.id}`;
const git = args => runCommand('git', ['-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${path.join(dataPath, 'empty-hooks')}`, '-C', fixture, ...args]);
const updatedMessage = 'Note saved. You can reopen it.';

await mkdir(path.join(dataPath, 'empty-hooks'), { recursive: true });
await cp(path.dirname(dashboardDll), buildPath, { recursive: true });
await cp(path.join(repositoryRoot, 'worker/tests/fixtures/notes-app'), fixture, { recursive: true });
await git(['init', '--initial-branch=main']);
await git(['config', 'user.name', 'Getright Notes Smoke']);
await git(['config', 'user.email', 'getright@example.invalid']);
await git(['add', '.']);
await git(['commit', '-m', 'Disposable Notes application']);
const baseCommit = (await git(['rev-parse', 'HEAD'])).output.trim();
await writeFile(configPath, JSON.stringify({ worktreeRoot: path.join(dataPath, 'trees'),
  recipes: { [manifest.buildRecipe.id]: { ...recipe, repositoryPath: fixture } } }));

const environment = { GETRIGHT_WORKER_CONFIG: configPath };
process.env.GETRIGHT_WORKER_CONFIG = configPath;
const dashboard = await dashboardHost(dataPath, { dllPath: copiedDll, environment });
const origin = dashboard.origin;
const configuration = { dashboardUrl: origin, dataPath, headless: true, keepBrowserOpen: false };
const get = route => api(origin, route);
const post = (route, body) => api(origin, route, body);
async function runNext() {
  const claim = await post('/api/worker/claim', workerClaim);
  assert(claim);
  const run = await executeRun(claim, configuration);
  assert.equal(run.status, 'passed', run.error);
  assert.equal(run.acceptance, 'pending');
  return run;
}

let host;
try {
  // Seed the existing installation, then onboard using only the copied JSON
  // definitions and trusted worker settings. The dashboard binary is identical.
  assert(!(await get('/api/catalog')).applications.some(application => application.id === app.id));
  await post('/api/runs', { testId: 'getright-save-note' });
  const demo = await runNext();
  assert.equal(demo.testSnapshot.adapter, 'configured-v2');
  assert.deepEqual(demo.steps.map(step => step.stepId), ['open', 'edit', 'save', 'reopen']);
  const existingSuite = await get('/api/suites/getright-suite');
  await dashboard.stop();
  const catalogFile = path.join(buildPath, 'catalog.json');
  const catalog = await json(catalogFile);
  catalog.applications.push(app);
  await writeFile(catalogFile, JSON.stringify(catalog));
  const manifestFile = path.join(buildPath, 'application-manifests.json');
  const manifests = await json(manifestFile);
  await writeFile(manifestFile, JSON.stringify([...manifests, manifest]));
  await dashboard.start();
  assert((await readFile(copiedDll)).equals(await readFile(dashboardDll)));
  assert.deepEqual(await get(`/api/runs/${demo.id}`), demo);
  assert.deepEqual(await get('/api/suites/getright-suite'), existingSuite);

  const options = await jobConfiguration(configuration, app.id, manifest.buildRecipe);
  const baseline = path.join(dataPath, 'baseline');
  await mkdir(baseline);
  const build = await options.build({ worktree: fixture, jobRoot: baseline,
    version: options.version('baseline'), resultCommit: baseCommit, log: boundedLog(path.join(dataPath, 'baseline-build.log')) });
  host = await options.launch({ build, resultCommit: baseCommit, sourceTarget: { expectedUserId: 'notes-uat' },
    log: boundedLog(path.join(dataPath, 'baseline-launch.log')) });
  assert.equal((await post(`${appRoute}/preview`, host.target)).readiness.ready, true);
  assert.equal(await get(`${appRoute}/profile`), null);
  await post(`${appRoute}/profile`, host.target);
  await post(`${appRoute}/workflows`, { revision: 0, definitionJson: JSON.stringify(workflow) });
  assert((await get(`/api/suites/${app.id}-suite`)).testIds.includes(workflow.id));
  await assert.rejects(post('/api/runs', { testId: workflow.id }), /qualification/);
  const proofs = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    await post(`${testRoute}/qualify`, {});
    assert.equal(await post('/api/worker/claim', { ...workerClaim, integrationContractVersion: undefined }), null);
    proofs.push(await runNext());
  }
  assert.notEqual(proofs[0].identity.resources[0].id, proofs[1].identity.resources[0].id);
  assert((await get(`${testRoute}/qualification`)).qualified);
  await post('/api/runs', { testId: workflow.id });
  const original = await runNext();
  const [resource] = original.identity.resources;
  assert.equal(resource.kind, 'note');
  assert.deepEqual(original.runtime.fixtures, [{ kind: 'note', id: resource.id, status: 'deleted' }]);
  assert.equal((await fetch(`${host.target.baseUrl}/api/notes/${resource.id}`)).status, 404);
  assert.equal(original.steps[1].apiObservations[0].method, 'PUT');
  assert.equal(original.steps[2].apiObservations[0].method, 'GET');
  await host.stop(); host = null;

  const feedback = await post(`/api/runs/${original.id}/feedback`, {
    stepId: 'save', comment: 'The save confirmation could explain how to check the saved note.',
    requestedOutcome: `In app.mjs, change the successful save confirmation to exactly "${updatedMessage}". Keep all other behaviors, the API and the workflow intact.`,
  });
  assert(feedback.prompt.includes(resource.id));
  const draft = await post('/api/jobs', { runId: original.id, feedbackId: feedback.id });
  assert.equal(draft.startBlocker, null);
  await post(`/api/jobs/${draft.id}/start`, { revision: draft.revision });
  const claim = await post('/api/worker/jobs/claim', workerClaim);
  const synthetic = { implement: async ({ worktree, report }) => {
    const file = path.join(worktree, 'app.mjs');
    const source = await readFile(file, 'utf8');
    await writeFile(file, source.replace("'Note saved.'", `'${updatedMessage}'`));
    await report('Synthetic edit to the disposable application.', { threadId: 'sample-notes-synthetic' });
    return { summary: 'Updated the note confirmation.' };
  } };
  const result = await executeJob(claim, configuration, live ? undefined : synthetic);
  assert.equal(result.status, 'awaiting-review', result.error);
  if (live) assert(result.threadId, 'The real Codex thread must be recorded.');
  const rerun = await get(`/api/runs/${result.rerunId}`);
  assert.equal(rerun.status, 'passed');
  assert.equal(rerun.acceptance, 'pending');
  assert.equal(rerun.parentRunId, original.id);
  assert.deepEqual(rerun.testSnapshot, original.testSnapshot);
  assert.equal(rerun.configuration.manifestDigest, original.configuration.manifestDigest);
  assert.equal(rerun.configuration.workflowDigest, original.configuration.workflowDigest);
  assert.notEqual(rerun.configuration.bindingDigest, original.configuration.bindingDigest);
  assert.notEqual(rerun.identity.resources[0].id, resource.id);
  assert.equal(rerun.target.sourceCommit, result.resultCommit);
  assert.deepEqual(rerun.target.buildReceipt, result.buildReceipt);
  assert.notEqual(result.resultCommit, baseCommit);
  assert((await readFile(path.join(result.worktreePath, 'app.mjs'), 'utf8')).includes(updatedMessage));
  assert.equal((await git(['rev-parse', 'HEAD'])).output.trim(), baseCommit);
  assert.equal((await git(['status', '--porcelain'])).output.trim(), '');
  assert((await readdir(path.join(dataPath, 'evidence', rerun.id))).includes('trace.zip'));
  await writeFile(path.join(dataPath, 'integration-report.json'), JSON.stringify({
    implementation: live ? 'real Codex SDK' : 'synthetic source edit', demo, proofs, original, result, rerun,
  }, null, 2));
  console.log(`PASS: configuration-only onboarding, owned fixtures, backend persistence and a ${live ? 'real Codex' : 'synthetic'} feedback-to-rerun cycle. Human review pending. Evidence: ${dataPath}`);
} finally {
  await host?.stop();
  await dashboard.stop();
}
