// Real dashboard/browser with disposable failed-job fixtures; no Codex/provider calls.
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { chromium, expect } from '@playwright/test';
import { api, repositoryRoot } from '../src/settings.mjs';
import { dashboardHost } from './dashboard-host.mjs';

const dataPath = path.join(repositoryRoot, '.local', `case-generation-retry-${Date.now()}`);
const dashboard = await dashboardHost(dataPath), origin = dashboard.origin;
const id = () => randomUUID().replaceAll('-', '');
const db = () => new DatabaseSync(path.join(dataPath, 'getright.db'));
const report = { scope: 'Single-case retry UI/API with synthetic job states; no paid generation or application changes', flows: [] };
let browser;
function seed(title, applicationId = 'getright') {
  const test = { id: `draft-${id()}`, applicationId, title, purpose: 'Disposable retry fixture.', readiness: 'draft', adapter: null,
    preconditions: 'Isolated synthetic data.', reviewQuestion: 'Can a failed case be retried independently?',
    steps: [{ id: 'review', title: 'Review the note', expected: 'The note is visible.' }] };
  const connection = db();
  connection.prepare('INSERT INTO draft_test_cases(id,suite_id,payload) VALUES(?,?,?)').run(test.id, `${applicationId}-suite`, JSON.stringify(test));
  connection.close(); return test;
}
async function attempt(test, status) {
  // A server-rendered approval produces the authoritative definition digest.
  const page = await browser.newPage(); await page.goto(origin+'/?view=generation');
  await page.getByRole('button', { name: test.title, exact: true }).click();
  await page.getByRole('region', { name: 'Test case implementation', exact: true }).getByRole('button', { name: 'Approve and implement test case', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Test case implementation', exact: true })).toContainText('Case approved and queued');
  await page.close();
  const [job] = await api(origin, `/api/case-implementations?test=${test.id}`);
  Object.assign(job, { status, error: `Synthetic ${status} failure.`, updatedAt: new Date().toISOString() });
  const store = db(); store.prepare('UPDATE case_implementation_jobs SET payload=? WHERE id=?').run(JSON.stringify(job), job.id);
  store.prepare('INSERT INTO case_implementation_events(job_id,created_at,stage,message) VALUES(?,?,?,?)').run(job.id, job.updatedAt, status, job.error);
  store.close(); return job;
}
async function postRetry(job, digest = job.definitionDigest) {
  return fetch(`${origin}/api/case-implementations/${job.id}/retry`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ definitionDigest: digest }) });
}
try {
  browser = await chromium.launch({ headless: true });
  const failed = seed('Failed single case'), interrupted = seed('Interrupted single case'), cancelled = seed('Cancelled single case');
  const failedJob = await attempt(failed, 'failed'), interruptedJob = await attempt(interrupted, 'interrupted'), cancelledJob = await attempt(cancelled, 'cancelled');
  const retained = await api(origin, `/api/case-implementations/${failedJob.id}`);
  const retainedEvents = await api(origin, `/api/case-implementations/${failedJob.id}/events`);
  const runId = id(), now = new Date().toISOString();
  const run = { id: runId, testId: failed.id, applicationId: 'getright', status: 'failed', acceptance: 'improvements-requested', createdAt: now,
    completedAt: now, fixtureId: `uat-${runId}`, buildVersion: 'synthetic', steps: [], testSnapshot: failed, caseImplementationJobId: failedJob.id };
  const store = db(); store.prepare('INSERT INTO runs(id,payload) VALUES(?,?)').run(runId, JSON.stringify(run)); store.close();
  const retainedRun = await api(origin, `/api/runs/${runId}`);
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(origin+'/?view=generation');
  const progress = page.getByRole('region', { name: 'Test case generation progress', exact: true });
  const row = test => progress.locator('.generation-case').filter({ has: page.getByRole('link', { name: test.title, exact: true }) });
  await row(failed).getByRole('button', { name: 'Retry case generation', exact: true }).click();
  await expect(row(failed).locator('.badge')).toHaveText('Queued');
  await expect(row(failed).getByRole('button', { name: 'Retry case generation', exact: true })).toHaveCount(0);
  const [retry] = await api(origin, `/api/case-implementations?test=${failed.id}`);
  assert.notEqual(retry.id, failedJob.id); assert.equal(retry.retryOfJobId, failedJob.id);
  assert.equal(retry.definitionDigest, failedJob.definitionDigest); assert.deepEqual(retry.testSnapshot, failedJob.testSnapshot);
  assert.equal(retry.validationRunIds, null); assert.equal(retry.resultCommit, null); assert.equal(retry.error, null);
  const concurrent = await Promise.all([postRetry(failedJob), postRetry(failedJob)]);
  for (const response of concurrent) { assert.equal(response.status, 200); assert.equal((await response.json()).id, retry.id); }
  assert.equal((await api(origin, `/api/case-implementations?test=${failed.id}`)).length, 2);
  assert.deepEqual(await api(origin, `/api/case-implementations/${failedJob.id}`), retained);
  assert.deepEqual(await api(origin, `/api/case-implementations/${failedJob.id}/events`), retainedEvents);
  assert.deepEqual(await api(origin, `/api/runs/${runId}`), retainedRun);
  assert.equal((await api(origin, `/api/case-implementations?test=${interrupted.id}`)).length, 1);
  assert.equal((await api(origin, `/api/case-implementations?test=${cancelled.id}`)).length, 1);
  await page.goto(`${origin}/case-implementations/${failedJob.id}`);
  await expect(page.getByRole('link', { name: 'View latest generation attempt', exact: true })).toHaveAttribute('href', `/case-implementations/${retry.id}`);
  await expect(page.getByRole('button', { name: 'Retry case generation', exact: true })).toHaveCount(0);
  await page.goto(`${origin}/case-implementations/${cancelledJob.id}`);
  await page.getByRole('button', { name: 'Retry case generation', exact: true }).click();
  await expect(page).not.toHaveURL(`${origin}/case-implementations/${cancelledJob.id}`);
  await expect(page.getByRole('link', { name: 'previous generation attempt', exact: true })).toHaveAttribute('href', `/case-implementations/${cancelledJob.id}`);
  await expect(page.getByRole('button', { name: 'Cancel implementation', exact: true })).toBeEnabled();
  await page.goto(origin+'/?view=generation'); await page.getByRole('button', { name: interrupted.title, exact: true }).click();
  const implementation = page.getByRole('region', { name: 'Test case implementation', exact: true });
  await implementation.getByRole('button', { name: 'Retry case generation', exact: true }).click();
  await expect(implementation.locator('.badge')).toHaveText('Queued');
  assert.equal((await api(origin, '/api/runs')).length, 1);
  report.flows.push('Control-room row, selected-case panel and failed-attempt page retry only one case; concurrent clicks share one fresh job; original jobs/events/run acceptance preserved.');

  assert.equal((await postRetry(retry)).status, 400, 'Queued attempts cannot be retried.');
  const changed = seed('Changed case needs review'), verified = seed('Verified case');
  const changedJob = await attempt(changed, 'failed'), verifiedJob = await attempt(verified, 'verified');
  assert.equal((await postRetry(verifiedJob)).status, 400);
  assert.equal((await postRetry(changedJob, 'stale')).status, 400);
  changed.purpose = 'Edited after the previous attempt.';
  const edit = db(); edit.prepare('UPDATE draft_test_cases SET payload=? WHERE id=?').run(JSON.stringify(changed), changed.id); edit.close();
  const staleResponse = await postRetry(changedJob); assert.equal(staleResponse.status, 400); assert.match(await staleResponse.text(), /case changed/);
  await page.goto(`${origin}/case-implementations/${changedJob.id}`);
  await expect(page.getByRole('button', { name: 'Retry case generation', exact: true })).toBeDisabled();
  await expect(page.getByText('The case definition changed.', { exact: false })).toBeVisible();
  await page.goto(origin+'/?view=generation'); await page.getByRole('button', { name: changed.title, exact: true }).click();
  await expect(implementation.getByRole('button', { name: 'Approve and implement test case', exact: true })).toBeEnabled();

  // Retrying a real application uses the current clean receipt, without its old
  // manual-review host. Missing/dirty receipts still fail instead of bypassing setup.
  const company = seed('Company setup retry', 'virtual-company');
  const profile = { applicationId: 'virtual-company', baseUrl: 'http://127.0.0.1:1', expectedBuildVersion: 'old-build', expectedUserId: 'synthetic-owner',
    expectedCompanyId: '04040404-0404-0404-0404-040404040404', expectedRole: 'owner', isolatedDataConfirmed: true, sourceCommit: 'a'.repeat(40), sourceWasDirty: false };
  await api(origin, '/api/applications/virtual-company/profile', profile);
  const companyJob = await attempt(company, 'failed');
  const missing = db(); missing.prepare("DELETE FROM application_profiles WHERE id='virtual-company'").run(); missing.close();
  await page.goto(`${origin}/case-implementations/${companyJob.id}`);
  await page.getByRole('button', { name: 'Retry case generation', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Configure an isolated application launch receipt first.' })).toBeVisible();
  await api(origin, '/api/applications/virtual-company/profile', { ...profile, sourceWasDirty: true });
  const dirty = await postRetry(companyJob); assert.equal(dirty.status, 400); assert.match(await dirty.text(), /clean committed/);
  const currentProfile = { ...profile, expectedBuildVersion: 'new-build', sourceCommit: 'b'.repeat(40) };
  await api(origin, '/api/applications/virtual-company/profile', currentProfile);
  await page.getByRole('button', { name: 'Retry case generation', exact: true }).click();
  await expect(page.getByRole('link', { name: 'previous generation attempt', exact: true })).toHaveAttribute('href', `/case-implementations/${companyJob.id}`);
  const [companyRetry] = await api(origin, `/api/case-implementations?test=${company.id}`);
  assert.equal(companyRetry.approvedTarget.sourceCommit, currentProfile.sourceCommit);
  await api(origin, `/api/case-implementations/${companyRetry.id}/cancel`, {});
  assert.equal((await postRetry(companyJob)).status, 400, 'An old failed attempt cannot bypass a newer terminal attempt.');
  assert.equal((await api(origin, `/api/case-implementations?test=${company.id}`)).length, 2);
  report.flows.push('Queued/verified and stale historical attempts cannot restart; edited cases require review; missing/dirty setup errors recover; retries freeze the current clean source receipt.');
  await page.goto(`${origin}/case-implementations/${companyRetry.id}`);
  await expect(page.getByRole('button', { name: 'Retry case generation', exact: true })).toBeEnabled();
  await page.screenshot({ path: path.join(dataPath, 'retry-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: 'Retry case generation', exact: true })).toBeEnabled();
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: path.join(dataPath, 'retry-mobile.png'), fullPage: true });
  assert.deepEqual(errors, []);
  assert.deepEqual(await api(origin, `/api/runs/${runId}`), retainedRun);
  for (const test of [failed, interrupted, cancelled, changed, company]) assert.equal((await api(origin, '/api/catalog')).tests.find(t => t.id === test.id).readiness, 'draft');
  const savedRetry = await api(origin, `/api/case-implementations/${retry.id}`);
  await dashboard.stop(); await dashboard.start();
  assert.deepEqual(await api(origin, `/api/case-implementations/${retry.id}`), savedRetry);
  assert.deepEqual(await api(origin, `/api/case-implementations/${failedJob.id}`), retained);
  assert.deepEqual(await api(origin, `/api/case-implementations/${failedJob.id}/events`), retainedEvents);
  assert.deepEqual(await api(origin, `/api/runs/${runId}`), retainedRun);
  report.flows.push('Retry provenance, queued state, previous attempt/events and run acceptance survive dashboard restart.');
  console.log(`PASS: single-case generation retries, deduplication, history/acceptance, setup/definition guards and desktop/mobile. Evidence: ${dataPath}`);
} finally {
  await browser?.close(); await dashboard.stop();
  await writeFile(path.join(dataPath, 'retry-report.json'), JSON.stringify(report, null, 2));
}
