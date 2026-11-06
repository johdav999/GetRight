import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { api, localUrl, repositoryRoot } from '../src/settings.mjs';
import { executeRun, workerClaim } from '../src/run-execution.mjs';
import { dashboardHost } from './dashboard-host.mjs';
import { createWriterAppContractHost } from './writerapp-contract-host.mjs';

const dataPath = path.join(repositoryRoot, '.local', `browser-review-${Date.now()}`);
await mkdir(dataPath, { recursive: true });
const dashboard = await dashboardHost(dataPath);
const configuration = { dashboardUrl: dashboard.origin, dataPath, headless: false };
const report = { scope: 'Visible browser review lifecycle; disposable data', flows: [], issues: [{
  id: 'REVIEW-001', severity: 'P1', flow: 'Review completed UAT',
  expected: 'A terminal run and immutable evidence are saved while the tested app stays open until the user closes it or stops the worker.',
  observed: 'The runner previously closed Chromium unconditionally before reporting completion.',
  status: 'open', regression: 'npm run smoke:review --prefix worker',
}] };
let writer, reviewBrowser;
async function run(testId, options) {
  await api(dashboard.origin, '/api/runs', { testId });
  const claim = await api(dashboard.origin, '/api/worker/claim', workerClaim);
  return executeRun(claim, { ...configuration, ...options });
}
try {
  let reviewed = false;
  const completed = await run('getright-save-note', { runTimeoutMs: 10000,
    onReviewReady: async ({ browser, run }) => {
      reviewed = true; reviewBrowser = browser;
      const stored = await api(dashboard.origin, `/api/runs/${run.id}`);
      assert.equal(stored.status, 'passed', stored.error);
      assert.equal(stored.acceptance, 'pending');
      const tracePath = path.join(dataPath, 'evidence', stored.trace);
      const recordedTrace = await readFile(tracePath);
      const page = browser.contexts()[0].pages()[0];
      await page.getByLabel('Title', { exact: true }).fill('Manual review after automation');
      await page.screenshot({ path: path.join(dataPath, 'manual-review.png') });
      // Longer than the automation deadline: review must no longer be supervised
      // as an in-progress run, expire its result or close the user's browser.
      await delay(11000);
      assert(browser.isConnected()); assert(!page.isClosed());
      assert.deepEqual(await api(dashboard.origin, `/api/runs/${run.id}`), stored);
      assert.deepEqual(await readFile(tracePath), recordedTrace);
      await page.close(); // Closing the last tab resumes the worker even if Chromium remains connected.
    } });
  assert(reviewed); assert(!reviewBrowser.isConnected());
  assert.equal(completed.status, 'passed'); assert.equal(completed.acceptance, 'pending');
  report.flows.push({ id: 'REVIEW-001', name: 'Completed result, frozen trace, deadline-free manual interaction and last-tab close', status: 'verified', runId: completed.id });

  const shutdown = new AbortController();
  const stopped = await run('getright-save-note', { signal: shutdown.signal,
    onReviewReady: async ({ browser, run }) => {
      reviewBrowser = browser;
      assert.equal((await api(dashboard.origin, `/api/runs/${run.id}`)).status, 'passed');
      shutdown.abort(new Error('Worker shutdown during manual review.'));
    } });
  assert(!reviewBrowser.isConnected()); assert.equal(stopped.status, 'passed'); assert.equal(stopped.acceptance, 'pending');
  report.flows.push({ id: 'REVIEW-002', name: 'Worker shutdown closes review without changing the completed run', status: 'verified', runId: stopped.id });

  let executionFinished = false;
  let reviewReady, remainingPage;
  const ready = new Promise(resolve => { reviewReady = resolve; });
  const multiTab = run('getright-save-note', { onReviewReady: async ({ browser }) => {
    reviewBrowser = browser;
    const context = browser.contexts()[0], original = context.pages()[0];
    remainingPage = await context.newPage();
    await original.close(); reviewReady();
  } }).then(result => { executionFinished = true; return result; });
  await Promise.race([ready, multiTab.then(() => { throw new Error('Review ended before an additional tab could be inspected.'); })]);
  await delay(250);
  assert(!executionFinished); assert(reviewBrowser.isConnected()); assert(!remainingPage.isClosed());
  await reviewBrowser.close(); // Native window close/disconnect is another exit path.
  assert.equal((await multiTab).status, 'passed');
  report.flows.push({ id: 'REVIEW-003', name: 'Additional tabs stay reviewable and browser disconnect resumes execution', status: 'verified' });

  writer = await createWriterAppContractHost();
  const profile = { applicationId: 'writerapp', baseUrl: writer.origin, expectedBuildVersion: writer.state.version,
    expectedUserId: writer.state.userId, isolatedDataConfirmed: true };
  await api(dashboard.origin, '/api/applications/writerapp/profile', profile);
  await api(dashboard.origin, '/api/runs', { testId: 'writerapp-create-save' });
  const wrongBuild = await api(dashboard.origin, '/api/worker/claim', workerClaim);
  writer.state.version = 'drifted-after-queue';
  reviewed = false;
  const failed = await executeRun(wrongBuild, { ...configuration, onReviewReady: async ({ browser, run }) => {
    reviewed = true; assert.equal(run.status, 'failed'); assert.equal(run.acceptance, 'pending');
    await browser.close();
  } });
  assert(reviewed); assert.equal(failed.status, 'failed');
  report.flows.push({ id: 'REVIEW-004', name: 'Failed automation remains inspectable without becoming accepted', status: 'verified', runId: failed.id });

  const autoClose = await run('getright-save-note', { keepBrowserOpen: false,
    onReviewReady: () => { throw new Error('Auto-close must not enter manual review.'); } });
  assert.equal(autoClose.status, 'passed');
  const timedOut = await run('getright-save-note', { runTimeoutMs: 1000,
    onReviewReady: () => { throw new Error('Interrupted automation must not retain a browser.'); } });
  assert.equal(timedOut.status, 'failed'); assert.match(timedOut.error, /time limit/);
  report.flows.push({ id: 'REVIEW-005', name: 'Explicit auto-close and automation timeout retain automatic cleanup', status: 'verified' });

  if (process.argv.includes('--virtual-company')) {
    const existing = localUrl(process.env.GETRIGHT_DASHBOARD_URL || 'http://127.0.0.1:5120');
    assert.equal((await api(existing, '/api/applications/virtual-company/readiness')).ready, true);
    const companyProfile = await api(existing, '/api/applications/virtual-company/profile');
    await api(dashboard.origin, '/api/applications/virtual-company/profile', companyProfile);
    const company = await run('virtual-company-workflow', { onReviewReady: async ({ browser, run }) => {
      assert.equal(run.status, 'passed', run.error); assert.equal(run.acceptance, 'pending');
      const page = browser.contexts()[0].pages()[0];
      assert(page.url().includes(`/settings/test-company?companyId=${run.identity.companyId}`));
      await page.locator('#test-recipients').fill('manual-review@example.invalid');
      await page.screenshot({ path: path.join(dataPath, 'virtual-company-review.png'), fullPage: true });
      await delay(1500); assert(browser.isConnected());
      assert.equal((await api(dashboard.origin, `/api/runs/${run.id}`)).acceptance, 'pending');
      await page.close();
    } });
    assert.equal(company.status, 'passed', company.error);
    report.flows.push({ id: 'REVIEW-006', name: 'Actual isolated Virtual Company remains interactive after permissions UAT', status: 'verified', runId: company.id, build: company.buildVersion });
  }
  report.issues[0].status = 'verified';
  console.log(`PASS: browser review, durable completion, immutable evidence, manual close, shutdown, auto-close and timeout. Evidence: ${dataPath}`);
} finally {
  await reviewBrowser?.close().catch(() => {}); await writer?.close(); await dashboard.stop();
  await writeFile(path.join(dataPath, 'review-report.json'), JSON.stringify(report, null, 2));
}
