import assert from 'node:assert/strict';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { api, repositoryRoot } from '../src/settings.mjs';
import { runCommand } from '../src/processes.mjs';
import { executeJob } from '../src/jobs.mjs';
import { executeRun, workerClaim } from '../src/run-execution.mjs';
import { createWriterAppContractHost } from './writerapp-contract-host.mjs';
import { dashboardHost } from './dashboard-host.mjs';

const dataPath = path.join(repositoryRoot, '.local', `build-recipe-${Date.now()}`);
const source = process.env.GETRIGHT_DASHBOARD_DLL || path.join(repositoryRoot, 'src/Getright.Dashboard/bin/Release/net10.0/Getright.Dashboard.dll');
const build = path.join(dataPath, 'dashboard-bin');
await cp(path.dirname(source), build, { recursive: true });
const catalogFile = path.join(build, 'catalog.json');
const catalog = JSON.parse(await readFile(catalogFile, 'utf8'));
const test = JSON.parse(await readFile(path.join(repositoryRoot, 'config/examples/writerapp-api-readiness.json'), 'utf8'));
catalog.tests.push(test);
await writeFile(catalogFile, JSON.stringify(catalog));
const manifestFile = path.join(build, 'application-manifests.json');
const manifests = JSON.parse(await readFile(manifestFile, 'utf8'));
const manifest = manifests.find(item => item.applicationId === 'writerapp');
const recipe = { id: 'writerapp-node-contract', version: 2 };
manifest.buildRecipe = recipe;
await writeFile(manifestFile, JSON.stringify(manifests));

const fixture = path.join(dataPath, 'application');
await mkdir(path.join(fixture, 'tools'), { recursive: true });
const git = args => runCommand('git', ['-C', fixture, ...args]);
await git(['init', '--initial-branch=main']);
await git(['config', 'user.name', 'Getright Contract']);
await git(['config', 'user.email', 'uat@example.invalid']);
await writeFile(path.join(fixture, 'package.json'), '{"private":true,"type":"module"}\n');
await writeFile(path.join(fixture, 'mode.txt'), 'baseline');
await writeFile(path.join(fixture, 'app.mjs'), `
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
const [origin, data] = process.argv.slice(2);
if (origin !== process.env.GETRIGHT_UAT_ORIGIN || data !== process.env.GETRIGHT_UAT_DATA || process.env.GETRIGHT_UAT_TEST_SECRET) process.exit(4);
if (mode === 'launch-fail') process.exit(7);
const version = mode === 'wrong-build' ? 'unrelated-build' : compiledVersion;
const userId = 'contract-uat-account';
const server = createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/uat/ready') return res.end(JSON.stringify({version, sourceCommit: compiledCommit, isolated: true, userId}));
  if (req.url === '/api/app/version') return res.end(JSON.stringify({version}));
  if (req.url === '/api/auth/me') return res.end(JSON.stringify({userId, isAuthenticated:true}));
  res.writeHead(404).end();
});
server.listen(Number(new URL(origin).port), '127.0.0.1');
await writeFile(path.join(data, 'started.json'), JSON.stringify({origin, pid: process.pid}));
`);
await writeFile(path.join(fixture, 'tools/build.mjs'), `
import { readFile, writeFile } from 'node:fs/promises';
const [artifact, version, commit] = process.argv.slice(2);
if (version !== process.env.GETRIGHT_BUILD_VERSION || commit !== process.env.GETRIGHT_SOURCE_COMMIT || process.env.GETRIGHT_UAT_TEST_SECRET) process.exit(4);
const mode = await readFile('mode.txt', 'utf8');
if (mode === 'build-fail') process.exit(5);
if (mode === 'dirty-source') await writeFile('mode.txt', 'unexpected compiler edit');
const prefix = 'const [compiledVersion, compiledCommit, mode] = ' + JSON.stringify([version, commit, mode]) + ';\\n';
await writeFile(artifact, prefix + await readFile('app.mjs', 'utf8'));
`);
await git(['add', '.']); await git(['commit', '-m', 'Synthetic Node application']);
const baseline = (await git(['rev-parse', 'HEAD'])).output.trim();
const localConfig = path.join(dataPath, 'worker.local.json');
const settings = { worktreeRoot: path.join(repositoryRoot, 'worktrees'), recipes: { [recipe.id]: {
  version: recipe.version, applicationId: 'writerapp', repositoryPath: fixture, sourceMarker: 'package.json',
  sparsePaths: ['/package.json', '/mode.txt', '/app.mjs', '/tools/'],
  process: { build: { executable: 'node', script: 'tools/build.mjs', args: ['{{artifact}}', '{{version}}', '{{commit}}'] },
    launch: { executable: 'node', args: ['{{origin}}', '{{data}}'] }, artifact: 'app.mjs', readyPath: '/uat/ready', readyTimeoutMs: 5000 },
} } };
await writeFile(localConfig, JSON.stringify(settings));
const priorConfig = process.env.GETRIGHT_WORKER_CONFIG;
const priorSecret = process.env.GETRIGHT_UAT_TEST_SECRET;
process.env.GETRIGHT_WORKER_CONFIG = localConfig;
process.env.GETRIGHT_UAT_TEST_SECRET = 'synthetic-recipe-test-value';

const app = await createWriterAppContractHost();
const dashboard = await dashboardHost(dataPath, { dllPath: path.join(build, path.basename(source)) });
const origin = dashboard.origin;
const configuration = { dashboardUrl: origin, dataPath, headless: true, keepBrowserOpen: false };
const profile = { applicationId: 'writerapp', baseUrl: app.origin, expectedUserId: app.state.userId,
  expectedBuildVersion: app.state.version, isolatedDataConfirmed: true, sourceCommit: baseline };
const createJob = (run, feedback) => api(origin, '/api/jobs', { runId: run.id, feedbackId: feedback.id });
const start = job => api(origin, `/api/jobs/${job.id}/start`, { revision: job.revision });
const claimJob = () => api(origin, '/api/worker/jobs/claim', workerClaim);
const queue = async () => {
  await api(origin, '/api/runs', { testId: test.id });
  const run = await executeRun(await api(origin, '/api/worker/claim', workerClaim), configuration);
  assert.equal(run.status, 'passed', run.error);
  const feedback = await api(origin, `/api/runs/${run.id}/feedback`, { stepId: 'build', comment: 'Contract test.', requestedOutcome: 'Change the synthetic host source.' });
  return { run, feedback };
};
const implementation = mode => async ({ worktree, report }) => {
  await writeFile(path.join(worktree, 'mode.txt'), mode);
  await report('Synthetic source edit.', { threadId: 'recipe-contract-thread' });
  return { summary: 'Synthetic recipe validation.' };
};
const assertStopped = async job => {
  const launch = JSON.parse(await readFile(path.join(dataPath, 'jobs', job.id, 'host', 'started.json'), 'utf8'));
  await assert.rejects(fetch(`${launch.origin}/uat/ready`, { signal: AbortSignal.timeout(1000) }));
};

try {
  await api(origin, '/api/applications/writerapp/profile', profile);
  const { run, feedback } = await queue();
  const next = async () => { await start(await createJob(run, feedback)); return claimJob(); };
  const draft = await createJob(run, feedback);
  assert.deepEqual(draft.recipe, recipe);
  await start(draft);
  assert.equal(await api(origin, '/api/worker/jobs/claim', { ...workerClaim, buildRecipeVersion: undefined }), null);
  const completed = await executeJob(await claimJob(), configuration, { implement: implementation('improved') });
  assert.equal(completed.status, 'awaiting-review', completed.error);
  const rerun = await api(origin, `/api/runs/${completed.rerunId}`);
  assert.equal(rerun.status, 'passed'); assert.equal(rerun.acceptance, 'pending');
  assert.equal(rerun.target.sourceCommit, completed.resultCommit);
  assert.equal(rerun.buildVersion, `getright-${completed.id}`);
  assert.deepEqual(rerun.target.buildReceipt, completed.buildReceipt);
  assert.deepEqual(await api(origin, `/api/jobs/${completed.id}/artifacts/build-receipt.json`), rerun.target);
  assert.equal((await git(['rev-parse', 'HEAD'])).output.trim(), baseline);
  await assertStopped(completed);

  for (const [mode, error] of [['build-fail', /exited with code 5/], ['dirty-source', /changed source/], ['launch-fail', /exited before readiness/], ['wrong-build', /different build/]]) {
    const failed = await executeJob(await next(), configuration, { implement: implementation(mode) });
    assert.equal(failed.status, 'failed'); assert.match(failed.error, error); assert.equal(failed.rerunId, null);
    assert.deepEqual(failed.recipe, recipe);
    if (mode === 'wrong-build') await assertStopped(failed);
  }
  const tamperedClaim = await next();
  const tampered = await executeJob(tamperedClaim, configuration, { implement: implementation('tamper'), run: async (claim, config) => {
    const result = await executeRun(claim, config);
    await writeFile(path.join(dataPath, 'jobs', tamperedClaim.job.id, 'compiled', 'app.mjs'), 'changed after execution');
    return result;
  } });
  assert.equal(tampered.status, 'failed'); assert.match(tampered.error, /build or static assets changed/);
  await assertStopped(tampered);

  const cancelling = await next();
  let entered;
  const launched = new Promise(resolve => { entered = resolve; });
  const cancellation = executeJob(cancelling, configuration, { implement: implementation('cancel'), run: async (_, { signal }) => {
    entered(); await delay(30000, undefined, { signal });
  } });
  await launched;
  await api(origin, `/api/jobs/${cancelling.job.id}/cancel`, {});
  assert.equal((await cancellation).status, 'cancelled');
  await assertStopped(cancelling.job);

  const untrusted = structuredClone(settings);
  untrusted.recipes[recipe.id].process.build.args.push('{{prompt}}');
  await writeFile(localConfig, JSON.stringify(untrusted));
  const rejectedRecipe = await executeJob(await next(), configuration, { implement: implementation('never-started') });
  assert.equal(rejectedRecipe.status, 'failed');
  assert.match(rejectedRecipe.error, /known variables/);
  assert.equal(rejectedRecipe.worktreePath, null);
  await writeFile(localConfig, JSON.stringify(settings));

  await dashboard.stop();
  manifest.capabilities = ['test']; delete manifest.buildRecipe;
  await writeFile(manifestFile, JSON.stringify(manifests));
  await dashboard.start();
  const only = await queue();
  const blocked = await createJob(only.run, only.feedback);
  assert.match(blocked.startBlocker, /implementation adapter/);
  await assert.rejects(start(blocked), /400/);
  console.log(`PASS: local Node recipe, source and artifact checks, readiness, linked rerun, failure cleanup, cancellation and test-only capability. Evidence: ${dataPath}`);
} finally {
  await dashboard.stop(); await app.close();
  if (priorConfig === undefined) delete process.env.GETRIGHT_WORKER_CONFIG; else process.env.GETRIGHT_WORKER_CONFIG = priorConfig;
  if (priorSecret === undefined) delete process.env.GETRIGHT_UAT_TEST_SECRET; else process.env.GETRIGHT_UAT_TEST_SECRET = priorSecret;
}
