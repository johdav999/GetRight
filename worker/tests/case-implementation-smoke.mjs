// Real dashboard/browser/Git, synthetic Codex output. No paid models/providers.
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { chromium, expect } from '@playwright/test';
import { api, repositoryRoot } from '../src/settings.mjs';
import { dashboardHost } from './dashboard-host.mjs';
import { executeCaseImplementation } from '../src/case-implementation.mjs';
import { executeRun, workerClaim } from '../src/run-execution.mjs';
import { runCommand } from '../src/processes.mjs';

const dataPath = path.join(repositoryRoot, '.local', `case-implementation-${Date.now()}`); await mkdir(dataPath, { recursive: true });
const dashboard = await dashboardHost(dataPath), origin = dashboard.origin;
const platform = path.join(dataPath, 'platform'); await mkdir(platform);
const git = args => runCommand('git', ['-C', platform, ...args]);
await git(['init', '--initial-branch=main']); await git(['config', 'user.name', 'Getright Contract']); await git(['config', 'user.email', 'uat@example.invalid']);
await writeFile(path.join(platform, 'README.md'), 'Synthetic test implementation source.'); await git(['add', '.']); await git(['commit', '-m', 'Synthetic platform baseline']);
const baseCommit = (await git(['rev-parse', 'HEAD'])).output.trim();
await writeFile(path.join(platform, 'README.md'), 'Unrelated dirty checkout work must remain.');
const configuration = { dashboardUrl: origin, dataPath, headless: true, caseJobOptions: { worktreeRoot: path.join(repositoryRoot, 'worktrees'), codexTimeoutMs: 15000 } };
const jobRoot = id => path.join(dataPath, 'case-implementations', id);
function seed(title = 'Save and reopen a generated note') {
  const id = `draft-${randomUUID().replaceAll('-', '')}`;
  const test = { id, applicationId: 'getright', title, purpose: 'Verify note persistence with isolated synthetic content.', readiness: 'draft', adapter: null,
    reviewQuestion: 'Is saving clear?', preconditions: 'A new local-storage note fixture.', generationId: null,
    steps: [{ id: 'step-1', title: 'Write and save a unique note', expected: 'Save confirmation appears.' }, { id: 'step-2', title: 'Reload the note', expected: 'The saved content remains.' }] };
  const db = new DatabaseSync(path.join(dataPath, 'getright.db'));
  db.prepare('INSERT INTO draft_test_cases(id,suite_id,payload) VALUES(?,?,?)').run(id, 'getright-suite', JSON.stringify(test));
  const suite = JSON.parse(db.prepare("SELECT payload FROM test_suites WHERE id='getright-suite'").get().payload); suite.testIds.push(id);
  db.prepare("UPDATE test_suites SET payload=? WHERE id='getright-suite'").run(JSON.stringify(suite)); db.close(); return test;
}
const plan = test => ({ version: 1, fixture: 'getright-note', entryPath: '/uat-fixture.html?fixture={{fixtureId}}', reviewPath: '/uat-fixture.html', steps: [
  { stepId: test.steps[0].id, actions: [{ kind: 'fill', selector: '#title', value: 'Note {{unique}}' }, { kind: 'fill', selector: '#body', value: 'Content {{fixtureId}}' }, { kind: 'click', selector: '#save' }, { kind: 'expect-text', selector: '#confirmation', value: 'Note saved successfully.' }] },
  { stepId: test.steps[1].id, actions: [{ kind: 'reload' }, { kind: 'expect-value', selector: '#title', value: 'Note {{unique}}' }, { kind: 'expect-value', selector: '#body', value: 'Content {{fixtureId}}' }] },
] });
const adapters = test => ({ platformRepository: platform, implement: async ({ worktree, report }) => {
  await report('Synthetic Codex plan implementation.', { threadId: 'synthetic-case-contract' });
  const file = path.join(worktree, 'config/implemented-tests', `${test.id}.json`); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(plan(test), null, 2));
  return { summary: 'Synthetic bounded plan.', threadId: 'synthetic-case-contract' };
} });
const approve = async test => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage(); await page.goto(origin+'/?view=generation');
    await page.getByRole('button', { name: test.title, exact: true }).click();
    await page.getByRole('button', { name: 'Approve and implement test case', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Test case implementation' })).toContainText('Case approved and queued');
    return (await api(origin, `/api/case-implementations?test=${test.id}`))[0];
  } finally { await browser?.close(); }
};
const claim = () => api(origin, '/api/worker/case-implementations/claim', workerClaim);
const rejected = async (route, body) => { const result = await fetch(`${origin}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); assert.equal(result.status, 400, `${route}: ${await result.text()}`); };
const lookup = async id => (await api(origin, '/api/catalog')).tests.find(t => t.id === id);
const report = { scope: 'Draft approval/implementation lifecycle; synthetic Codex output with real Git/browser/evidence', flows: [], issues: [] };
let browser;
try {
  const test = seed(); const queued = await approve(test); assert.equal(queued.status, 'queued'); assert.equal((await lookup(test.id)).readiness, 'draft');
  await rejected('/api/runs', { testId: test.id });
  await rejected(`/api/tests/${test.id}/approve-implementation`, { definitionDigest: 'stale' });
  assert.equal((await api(origin, `/api/tests/${test.id}/approve-implementation`, { definitionDigest: queued.definitionDigest })).id, queued.id, 'Approval retries must not duplicate an active job.');
  const claimed = await claim(); assert.equal(claimed.job.id, queued.id); assert.equal(await claim(), null);
  await rejected(`/api/case-implementations/${queued.id}/heartbeat`, { lease: 'bad' });
  await rejected(`/api/case-implementations/${queued.id}/finish`, { lease: claimed.lease, status: 'verified' });
  const verified = await executeCaseImplementation(claimed, configuration, adapters(test));
  assert.equal(verified.status, 'verified', verified.error); assert.equal(verified.validationRunIds.length, 2);
  assert.equal((await git(['rev-parse', 'HEAD'])).output.trim(), baseCommit); assert.equal(await readFile(path.join(platform, 'README.md'), 'utf8'), 'Unrelated dirty checkout work must remain.');
  const enabled = await lookup(test.id); assert.equal(enabled.readiness, 'ready'); assert.equal(enabled.adapter, 'declarative-v1'); assert(enabled.implementation.planDigest);
  for (const runId of verified.validationRunIds) { const run = await api(origin, `/api/runs/${runId}`); assert.equal(run.status, 'passed'); assert.equal(run.acceptance, 'pending'); assert.equal(run.steps.length, 2); assert.equal((await fetch(`${origin}/api/evidence/${run.trace}`)).status, 200); }
  const normal = await api(origin, '/api/runs', { testId: test.id }); assert.equal(await api(origin, '/api/worker/claim', {}), null, 'Legacy workers must not claim new workflows.');
  assert.equal(normal.configuration.requiredEngineDigest, workerClaim.workflowEngineDigest);
  assert.equal(await api(origin, '/api/worker/claim', { ...workerClaim, workflowEngineDigest: 'f'.repeat(64) }), null, 'A different engine cannot claim a verified workflow.');
  const result = await executeRun(await api(origin, '/api/worker/claim', workerClaim), configuration); assert.equal(result.id, normal.id); assert.equal(result.status, 'passed', result.error); assert.equal(result.acceptance, 'pending');
  // A generated declarative workflow must use the same step gates as built-ins;
  // its two implementation proofs above remain automatic.
  const stepped = await api(origin, '/api/runs', { testId: test.id, docked: true, stepByStep: true }), steppedStop = new AbortController();
  const steppedExecution = executeRun(await api(origin, '/api/worker/claim', workerClaim), { ...configuration, keepBrowserOpen: false, signal: steppedStop.signal });
  try {
    for (const step of test.steps) {
      let state;
      for (let index = 0; index < 150; index++) { state = await api(origin, `/api/runs/${stepped.id}/browser`); if (state.canAdvance && state.stepId === step.id) break; await delay(50); }
      assert.equal(state.stepId, step.id); assert.equal(state.canAdvance, true);
      await api(origin, `/api/runs/${stepped.id}/browser/advance`, { stepId: step.id });
    }
    const stepResult = await steppedExecution; assert.equal(stepResult.status, 'passed', stepResult.error); assert.equal(stepResult.acceptance, 'pending'); assert.equal(stepResult.steps.length, test.steps.length);
  } finally { steppedStop.abort(new Error('Disposable declarative step check finished.')); await steppedExecution.catch(() => {}); }
  await api(origin, `/api/runs/${verified.validationRunIds[0]}/review`, { acceptance: 'accepted' });
  assert.equal((await api(origin, `/api/runs/${normal.id}`)).acceptance, 'pending');
  const requeued = await api(origin, `/api/tests/${test.id}/approve-implementation`, { definitionDigest: queued.definitionDigest });
  assert.equal(requeued.retainedPlan.binding.jobId, verified.id);
  const reverified = await executeCaseImplementation(await claim(), configuration, { platformRepository: platform, implement: () => { throw new Error('Revalidation must not invoke a model for an unchanged verified plan.'); } });
  assert.equal(reverified.status, 'verified', reverified.error); assert.equal(reverified.planJson, verified.planJson);
  for (const id of reverified.validationRunIds) assert.equal((await api(origin, `/api/runs/${id}`)).acceptance, 'pending');
  browser = await chromium.launch({ headless: true }); const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(origin+'/?view=generation'); await page.getByRole('button', { name: test.title, exact: true }).click();
  await expect(page.getByRole('region', { name: 'Test case implementation' })).toContainText('Verified automation is enabled');
  await page.screenshot({ path: path.join(dataPath, 'verified-case-desktop.png'), fullPage: true });
  await page.goto(`${origin}/case-implementations/${verified.id}`); await expect(page.getByRole('heading', { name: 'Committed workflow plan' })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 }); assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); await page.screenshot({ path: path.join(dataPath, 'implementation-mobile.png'), fullPage: true });
  await api(origin, `/api/tests/${test.id}/disable-implementation`, {}); assert.equal((await lookup(test.id)).readiness, 'draft'); await rejected('/api/runs', { testId: test.id });
  report.flows.push({ id: 'CASE-001', name: 'Approve, isolated worktree/commit, two real runs, activation, legacy-worker exclusion, normal rerun, independent acceptance and disable', status: 'verified', jobId: verified.id });

  const bad = seed('A deliberately failing draft'); const badQueued = await approve(bad);
  const badAdapters = adapters(bad); badAdapters.implement = async ({ worktree, report }) => { await report('Synthetic failing plan.', { threadId: 'synthetic-failure' }); const failedPlan = plan(bad); failedPlan.steps[0].actions.at(-1).value = 'Deliberately incorrect expected text'; const file = path.join(worktree, 'config/implemented-tests', `${bad.id}.json`); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(failedPlan)); return { threadId: 'synthetic-failure' }; };
  const failed = await executeCaseImplementation(await claim(), configuration, badAdapters); assert.equal(failed.id, badQueued.id); assert.equal(failed.status, 'failed'); assert.equal((await lookup(bad.id)).readiness, 'draft'); assert.equal(failed.validationRunIds.length, 1);
  const unsafe = seed('Unsafe output must stay disabled'); await approve(unsafe);
  const unsafeAdapters = adapters(unsafe); unsafeAdapters.implement = async ({ worktree, report }) => { await report('Synthetic invalid output.', { threadId: 'synthetic-unsafe' }); const invalid = plan(unsafe); invalid.steps[0].actions.unshift({ kind: 'evaluate', value: 'alert(1)' }); const file = path.join(worktree, 'config/implemented-tests', `${unsafe.id}.json`); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(invalid)); return { threadId: 'synthetic-unsafe' }; };
  const refused = await executeCaseImplementation(await claim(), configuration, unsafeAdapters); assert.equal(refused.status, 'failed'); assert.equal(refused.validationRunIds, null); assert.equal((await lookup(unsafe.id)).readiness, 'draft');
  report.flows.push({ id: 'CASE-002', name: 'Failing assertion and unsafe plan cannot enable a draft; evidence/worktrees remain', status: 'verified' });

  const activeCancel = seed('Cancel a running validation'); const activeJob = await approve(activeCancel);
  const activeAdapters = adapters(activeCancel); activeAdapters.implement = async ({ worktree, report }) => {
    await report('Synthetic slow validation.', { threadId: 'synthetic-cancel' });
    const delayed = plan(activeCancel); delayed.steps[0].actions = [{ kind: 'expect-visible', selector: '#intentionally-missing-until-cancelled' }];
    const file = path.join(worktree, 'config/implemented-tests', `${activeCancel.id}.json`); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(delayed)); return { threadId: 'synthetic-cancel' };
  };
  const running = executeCaseImplementation(await claim(), configuration, activeAdapters);
  let validating;
  for (let i = 0; i < 100; i++) { validating = await api(origin, `/api/case-implementations/${activeJob.id}`); if (validating.validationRunIds?.length) break; await delay(50); }
  assert.equal(validating.validationRunIds.length, 1); await api(origin, `/api/case-implementations/${activeJob.id}/cancel`, {});
  assert.equal((await running).status, 'cancelled');
  assert.equal((await api(origin, `/api/runs/${validating.validationRunIds[0]}`)).status, 'interrupted');
  assert.equal((await lookup(activeCancel.id)).readiness, 'draft');

  const cancelled = seed('Cancelled implementation'); const cancelledJob = await approve(cancelled); await api(origin, `/api/case-implementations/${cancelledJob.id}/cancel`, {}); assert.equal(await claim(), null);
  const expired = seed('Expired implementation'); const expiredJob = await approve(expired); const expiredClaim = await claim();
  const db = new DatabaseSync(path.join(dataPath, 'getright.db')); db.prepare('UPDATE case_implementation_jobs SET lease_expires=? WHERE id=?').run('2000-01-01T00:00:00+00:00', expiredJob.id); db.close();
  assert.equal((await api(origin, `/api/case-implementations/${expiredJob.id}`)).status, 'interrupted');
  await rejected(`/api/case-implementations/${expiredJob.id}/finish`, { lease: expiredClaim.lease, status: 'verified' });
  const interrupted = seed('Restarted implementation'); const interruptedJob = await approve(interrupted); await claim();
  await dashboard.stop(); await dashboard.start(); assert.equal((await api(origin, `/api/case-implementations/${interruptedJob.id}`)).status, 'interrupted'); assert.equal((await lookup(interrupted.id)).readiness, 'draft');
  assert.equal((await api(origin, `/api/runs/${verified.validationRunIds[0]}`)).acceptance, 'accepted');
  report.flows.push({ id: 'CASE-003', name: 'Queued/active cancellation with linked run interruption, expired lease/stale finish, restart interruption and retained human acceptance', status: 'verified' });
  console.log(`PASS: draft implementation UI, Git/engine attribution, repeatability, activation, normal runs, failure/cancellation/recovery and mobile. Evidence: ${dataPath}`);
} finally {
  await browser?.close(); await dashboard.stop(); await writeFile(path.join(dataPath, 'case-implementation-report.json'), JSON.stringify(report, null, 2));
}
