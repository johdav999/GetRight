// Orchestration contract tests: real Git/worktrees, dashboard and browsers;
// explicit synthetic application and implementation adapters, no Codex API calls.
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { chromium, expect } from '@playwright/test';
import { repositoryRoot, api } from '../src/settings.mjs';
import { runCommand } from '../src/processes.mjs';
import { executeRun } from '../src/runner.mjs';
import { executeJob } from '../src/jobs.mjs';
import { dashboardHost } from './dashboard-host.mjs';
import { createWriterAppContractHost } from './writerapp-contract-host.mjs';

const dataPath = path.join(repositoryRoot, '.local', `jobs-smoke-${Date.now()}`); await mkdir(dataPath, { recursive: true });
const db = new DatabaseSync(path.join(dataPath, 'getright.db'));
db.exec('CREATE TABLE runs(id TEXT PRIMARY KEY,payload TEXT NOT NULL,lease TEXT); CREATE TABLE feedback(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id),payload TEXT NOT NULL); CREATE TABLE application_profiles(id TEXT PRIMARY KEY,payload TEXT NOT NULL); PRAGMA user_version=2;'); db.close();
const fixtureRepo = path.join(dataPath, 'repository'); await mkdir(fixtureRepo);
const git = args => runCommand('git', ['-C', fixtureRepo, ...args]);
await git(['init', '--initial-branch=main']); await git(['config', 'user.name', 'Getright Contract Test']); await git(['config', 'user.email', 'uat@local.invalid']);
await writeFile(path.join(fixtureRepo, 'BlazorApp.csproj'), '<Project />\n'); await writeFile(path.join(fixtureRepo, 'app.txt'), 'baseline\n');
await git(['add', '.']); await git(['commit', '-m', 'Synthetic baseline']);
const baseCommit = (await git(['rev-parse', 'HEAD'])).output.trim();
const dashboard = await dashboardHost(dataPath); const origin = dashboard.origin;
const configuration = { dashboardUrl: origin, dataPath, headless: true, jobOptions: { repositoryPath: fixtureRepo, worktreeRoot: path.join(repositoryRoot, 'worktrees'), codexTimeoutMs: 10000, buildTimeoutMs: 10000 } };
let baselineHost, browser;
const createdHosts = [];
const rejected = async (route, body) => {
  const response = await fetch(`${origin}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(response.status, 400, route);
};
try {
  baselineHost = await createWriterAppContractHost();
  const profile = { applicationId: 'writerapp', baseUrl: baselineHost.origin, expectedBuildVersion: baselineHost.state.version, expectedUserId: baselineHost.state.userId, isolatedDataConfirmed: true, sourceCommit: baseCommit, sourceWasDirty: false };
  await api(origin, '/api/applications/writerapp/profile', profile);
  const original = await api(origin, '/api/runs', { testId: 'writerapp-create-save' });
  const originalClaim = await api(origin, '/api/worker/claim', {});
  assert.equal((await executeRun(originalClaim, configuration)).status, 'passed');
  const feedback = await api(origin, `/api/runs/${original.id}/feedback`, { stepId: 'library', comment: 'Synthetic contract feedback.', requestedOutcome: 'Record a reviewable change while preserving the workflow.' });
  const unicodeDraft = await api(origin, '/api/jobs', { runId: original.id, feedbackId: feedback.id });
  const unicodeSaved = await api(origin, `/api/jobs/${unicodeDraft.id}/draft`, { revision: unicodeDraft.revision, prompt: '文'.repeat(23999) });
  assert.equal(unicodeSaved.prompt.length, 23999, 'full-length Unicode prompts must fit the bounded API request limit');
  await api(origin, `/api/jobs/${unicodeDraft.id}/cancel`, {});
  await api(origin, '/api/applications/writerapp/profile', { ...profile, sourceWasDirty: true });
  const dirtyRun = await api(origin, '/api/runs', { testId: 'writerapp-create-save' });
  assert.equal((await executeRun(await api(origin, '/api/worker/claim', {}), configuration)).status, 'passed');
  const dirtyFeedback = await api(origin, `/api/runs/${dirtyRun.id}/feedback`, { stepId: 'library', comment: 'Dirty-source contract.', requestedOutcome: 'A reproducible source base is required.' });
  const blocked = await api(origin, '/api/jobs', { runId: dirtyRun.id, feedbackId: dirtyFeedback.id });
  assert.match(blocked.startBlocker, /clean committed/);
  await rejected(`/api/jobs/${blocked.id}/start`, { revision: blocked.revision });
  await api(origin, `/api/jobs/${blocked.id}/cancel`, {});
  await api(origin, '/api/applications/writerapp/profile', profile);

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/runs/${original.id}`);
  await page.getByRole('button', { name: 'Prepare Codex job', exact: true }).click();
  await page.waitForURL(/\/jobs\/[a-f0-9]{32}$/);
  const id = page.url().split('/').at(-1);
  let draft = await api(origin, `/api/jobs/${id}`); assert.equal(draft.status, 'draft');
  const edited = `${draft.prompt}\n\nAdditional contract acceptance: keep the baseline checkout unchanged.`;
  await page.getByLabel('Task prompt', { exact: true }).fill(edited);
  await expect(page.getByRole('button', { name: 'Implement improvement', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Save task', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Task saved');
  await rejected(`/api/jobs/${id}/draft`, { prompt: 'stale edit', revision: draft.revision });
  draft = await api(origin, `/api/jobs/${id}`); assert.equal(draft.prompt, edited);
  await page.getByRole('button', { name: 'Implement improvement', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Implementation queued');
  await rejected(`/api/jobs/${id}/start`, { revision: draft.revision });
  const claims = await Promise.all([api(origin, '/api/worker/jobs/claim', {}), api(origin, '/api/worker/jobs/claim', {})]);
  assert.equal(claims.filter(Boolean).length, 1); const claim = claims.find(Boolean);
  await rejected(`/api/jobs/${id}/report`, { lease: 'wrong', stage: 'implementing', message: 'invalid' });
  await rejected(`/api/jobs/${id}/report`, { lease: claim.lease, stage: 'launching', message: 'invalid jump' });
  await rejected(`/api/jobs/${id}/finish`, { lease: claim.lease, status: 'awaiting-review' });
  await api(origin, `/api/jobs/${id}/heartbeat`, { lease: claim.lease });

  const adapters = {
    implement: async ({ worktree, report, log, signal }) => {
      signal.throwIfAborted(); log('Synthetic implementation adapter; not a Codex call.\n');
      await writeFile(path.join(worktree, 'app.txt'), 'reviewed synthetic improvement\n');
      await report('Synthetic implementation completed for contract verification.', { threadId: 'contract-thread' });
      return { summary: 'Synthetic change for orchestration contract verification.' };
    },
    build: async ({ worktree, jobRoot, version, log }) => { log('Synthetic build adapter.\n'); return { worktree, jobRoot, version }; },
    launch: async ({ build, resultCommit, log }) => {
      log('Synthetic runtime adapter.\n'); const host = await createWriterAppContractHost(); createdHosts.push(host);
      host.state.version = build.version; host.state.userId = profile.expectedUserId;
      return { target: { ...profile, baseUrl: host.origin, expectedBuildVersion: build.version, sourceCommit: resultCommit }, stop: async () => { await host.close(); createdHosts.splice(createdHosts.indexOf(host), 1); } };
    },
  };
  const completed = await executeJob(claim, configuration, adapters);
  assert.equal(completed.status, 'awaiting-review', completed.error); assert(completed.threadId); assert.notEqual(completed.resultCommit, baseCommit);
  assert.equal((await git(['rev-parse', 'HEAD'])).output.trim(), baseCommit);
  assert.equal(await readFile(path.join(fixtureRepo, 'app.txt'), 'utf8'), 'baseline\n');
  const rerun = await api(origin, `/api/runs/${completed.rerunId}`);
  assert.equal(rerun.parentRunId, original.id); assert.equal(rerun.improvementJobId, id);
  assert.equal(rerun.status, 'passed'); assert.equal(rerun.acceptance, 'pending');
  assert.equal(rerun.target.sourceCommit, completed.resultCommit); assert.equal(rerun.buildVersion, completed.buildVersion);
  assert.equal((await api(origin, `/api/runs/${original.id}`)).acceptance, 'improvements-requested');
  assert.equal((await api(origin, '/api/applications/writerapp/profile')).baseUrl, profile.baseUrl);
  assert(!('lease' in completed));
  const events = await api(origin, `/api/jobs/${id}/events`); assert(events.some(event => event.stage === 'implementing'));
  assert.equal((await api(origin, `/api/jobs/${id}/events?after=${events.at(-1).sequence}`)).length, 0);
  await rejected(`/api/jobs/${id}/finish`, { lease: claim.lease, status: 'failed' });
  assert.equal((await fetch(`${origin}/api/jobs/${id}/artifacts/diff.patch`)).status, 200);
  assert.equal((await fetch(`${origin}/api/jobs/${id}/artifacts/not-allowed.txt`)).status, 404);
  await page.goto(`${origin}/jobs/${id}`);
  await expect(page.getByRole('heading', { name: 'Original and changed evidence', exact: true })).toBeVisible();
  await page.screenshot({ path: path.join(dataPath, 'job-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'mobile job review must not overflow');
  await page.screenshot({ path: path.join(dataPath, 'job-mobile.png'), fullPage: true });
  assert.deepEqual(errors, []);

  async function nextClaim() {
    const job = await api(origin, '/api/jobs', { runId: original.id, feedbackId: feedback.id });
    await api(origin, `/api/jobs/${job.id}/start`, { revision: job.revision });
    return api(origin, '/api/worker/jobs/claim', {});
  }
  const failedClaim = await nextClaim();
  const failed = await executeJob(failedClaim, configuration, { ...adapters, build: async () => { throw new Error('Deliberate build failure.'); } });
  assert.equal(failed.status, 'failed'); assert.match(failed.error, /Deliberate build failure/); assert.equal(failed.rerunId, null);
  const regressionClaim = await nextClaim();
  const regressionFailed = await executeJob(regressionClaim, configuration, { ...adapters, run: async claim => api(origin, `/api/runs/${claim.run.id}/complete`, { lease: claim.lease, status: 'failed', steps: [], error: 'Deliberate regression failure.' }) });
  assert.equal(regressionFailed.status, 'failed'); assert.equal((await api(origin, `/api/runs/${regressionFailed.rerunId}`)).status, 'failed');
  const cancelClaim = await nextClaim();
  let started; const startedPromise = new Promise(resolve => { started = resolve; });
  const cancelWork = executeJob(cancelClaim, configuration, { ...adapters, implement: async ({ signal }) => { started(); await delay(30000, undefined, { signal }); } });
  await startedPromise; await api(origin, `/api/jobs/${cancelClaim.job.id}/cancel`, {});
  assert.equal((await cancelWork).status, 'cancelled');
  const cancelRerunClaim = await nextClaim();
  let rerunStarted, ownedRerun;
  const rerunStartedPromise = new Promise(resolve => { rerunStarted = resolve; });
  const cancelRerunWork = executeJob(cancelRerunClaim, configuration, { ...adapters, run: async (claim, config) => { ownedRerun = claim; rerunStarted(); await delay(30000, undefined, { signal: config.signal }); } });
  await rerunStartedPromise; await api(origin, `/api/jobs/${cancelRerunClaim.job.id}/cancel`, {});
  assert.equal((await cancelRerunWork).status, 'cancelled');
  assert.equal((await api(origin, `/api/runs/${ownedRerun.run.id}`)).status, 'interrupted');
  await rejected(`/api/runs/${ownedRerun.run.id}/complete`, { lease: ownedRerun.lease, status: 'failed' });
  const timedClaim = await nextClaim();
  const timed = await executeJob(timedClaim, { ...configuration, jobOptions: { ...configuration.jobOptions, buildTimeoutMs: 1000 } }, { ...adapters, build: async ({ signal }) => delay(30000, undefined, { signal }) });
  assert.equal(timed.status, 'failed'); assert.equal(timed.rerunId, null); assert(timed.resultCommit);
  const queued = await api(origin, '/api/jobs', { runId: original.id, feedbackId: feedback.id });
  await api(origin, `/api/jobs/${queued.id}/start`, { revision: queued.revision });
  assert.equal((await api(origin, `/api/jobs/${queued.id}/cancel`, {})).status, 'cancelled');
  assert.equal(await api(origin, '/api/worker/jobs/claim', {}), null);

  const expiredClaim = await nextClaim();
  await api(origin, `/api/jobs/${expiredClaim.job.id}/report`, { lease: expiredClaim.lease, stage: 'implementing', message: 'Recovery contract.', threadId: 'recovery-contract', worktreePath: path.join(repositoryRoot, 'worktrees/recovery-contract') });
  await api(origin, `/api/jobs/${expiredClaim.job.id}/report`, { lease: expiredClaim.lease, stage: 'building', message: 'Recovery contract.', resultCommit: 'b'.repeat(40), buildVersion: '0.2.1.99' });
  await api(origin, `/api/jobs/${expiredClaim.job.id}/report`, { lease: expiredClaim.lease, stage: 'launching', message: 'Recovery contract.' });
  const expiringRun = await api(origin, `/api/jobs/${expiredClaim.job.id}/rerun`, { lease: expiredClaim.lease, target: { ...profile, baseUrl: 'http://127.0.0.1:2', expectedBuildVersion: '0.2.1.99', sourceCommit: 'b'.repeat(40) } });
  const sqlite = new DatabaseSync(path.join(dataPath, 'getright.db')); sqlite.exec('PRAGMA busy_timeout=5000');
  sqlite.prepare('UPDATE improvement_jobs SET lease_expires=? WHERE id=?').run('2000-01-01T00:00:00.0000000+00:00', expiredClaim.job.id); sqlite.close();
  assert.equal((await api(origin, `/api/jobs/${expiredClaim.job.id}`)).status, 'interrupted');
  assert.equal((await api(origin, `/api/runs/${expiringRun.run.id}`)).status, 'interrupted');
  await rejected(`/api/runs/${expiringRun.run.id}/complete`, { lease: expiringRun.lease, status: 'failed' });
  await rejected(`/api/jobs/${expiredClaim.job.id}/heartbeat`, { lease: expiredClaim.lease });
  const restartClaim = await nextClaim();
  await dashboard.stop(); await dashboard.start();
  assert.equal((await api(origin, `/api/jobs/${restartClaim.job.id}`)).status, 'interrupted');
  assert.equal((await api(origin, `/api/jobs/${id}`)).status, 'awaiting-review');
  assert.equal((await api(origin, `/api/runs/${rerun.id}`)).acceptance, 'pending');
  await rejected(`/api/jobs/${restartClaim.job.id}/report`, { lease: restartClaim.lease, stage: 'implementing', message: 'stale' });
  console.log(`PASS: schema-2 upgrade, editable job UI, worktree/commit isolation, linked rerun, progress/artifacts, pending acceptance, build/regression failures, cancellation, lease expiry and restart recovery.\nSynthetic contract evidence: ${dataPath}`);
} finally { await browser?.close(); for (const host of createdHosts) await host.close(); await baselineHost?.close(); await dashboard.stop(); }
