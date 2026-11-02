// Browser/SQLite integration against disposable fixtures. Never invokes Codex.
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { api, repositoryRoot } from '../src/settings.mjs';
import { executeRun } from '../src/runner.mjs';
import { dashboardHost } from './dashboard-host.mjs';
import { createWriterAppContractHost } from './writerapp-contract-host.mjs';

const dataPath = path.join(repositoryRoot, '.local', `quick-review-${Date.now()}`); await mkdir(dataPath, { recursive: true });
const dashboard = await dashboardHost(dataPath), origin = dashboard.origin;
const configuration = { dashboardUrl: origin, dataPath, headless: true };
let browser, writer;
const report = { scope: 'Control room quick review above workflow details; synthetic isolated data', flows: [], issues: [{
  id: 'QUICK-REVIEW-001', severity: 'P2', flow: 'Review latest case run',
  observed: 'Acceptance, comments and improvement preparation required opening a nested run-review page.',
  expected: 'Review, comment, preview and explicitly queue an improvement from the right panel above Workflow detail, retaining immutable run/step provenance.', status: 'open' }] };
const queue = testId => api(origin, '/api/runs', { testId });
const run = async testId => { await queue(testId); const completed = await executeRun(await api(origin, '/api/worker/claim', {}), configuration); assert.equal(completed.status, 'passed', completed.error); return completed; };
try {
  browser = await chromium.launch({ headless: true }); const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin); const panel = page.getByRole('region', { name: 'Quick run review' });
  await expect(panel).toContainText('Run this test case'); assert.equal(await panel.getByRole('button', { name: 'Accept this run' }).count(), 0);
  const waiting = await queue('getright-save-note'); await page.reload();
  await expect(panel.getByRole('button', { name: 'Accept this run', exact: true })).toBeDisabled();
  await expect(panel.getByLabel('What needs improving?', { exact: true })).toBeDisabled();
  const completed = await executeRun(await api(origin, '/api/worker/claim', {}), configuration);
  assert.equal(completed.id, waiting.id); assert.equal(completed.acceptance, 'pending');
  await expect(panel.getByRole('button', { name: 'Accept this run', exact: true })).toBeEnabled();
  await panel.getByRole('button', { name: 'Accept this run', exact: true }).click(); await expect(panel.getByRole('status')).toContainText('Review saved');
  assert.equal((await api(origin, `/api/runs/${completed.id}`)).acceptance, 'accepted');
  await panel.getByRole('button', { name: 'Request improvements', exact: true }).click();
  await expect(panel.locator('.quick-run-status .badge.improvements-requested')).toBeVisible();
  await panel.getByRole('button', { name: 'Reset to pending', exact: true }).click();
  await expect(panel.locator('.quick-run-status .badge.pending')).toBeVisible();
  await panel.getByRole('button', { name: 'Create improvement task', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('Provide feedback');
  await panel.getByLabel('Test step', { exact: true }).selectOption('save');
  await panel.getByLabel('What needs improving?', { exact: true }).fill('The confirmation should be easier to see.');
  await panel.getByLabel('Requested outcome', { exact: true }).fill('Show a clear save confirmation beside the save action.');
  const newer = await run('getright-save-note');
  await expect(panel).toContainText(`A newer run (${newer.id.slice(0, 8)})`);
  await expect(panel.getByLabel('What needs improving?', { exact: true })).toHaveValue('The confirmation should be easier to see.');
  await panel.getByRole('button', { name: 'Accept this run', exact: true }).click();
  await expect.poll(async () => (await api(origin, `/api/runs/${completed.id}`)).acceptance).toBe('accepted');
  assert.equal((await api(origin, `/api/runs/${newer.id}`)).acceptance, 'pending');
  await panel.getByRole('button', { name: 'Create improvement task', exact: true }).click();
  await expect(panel.getByRole('status')).toContainText('Improvement task created');
  const [feedback] = await api(origin, `/api/runs/${completed.id}/feedback`);
  assert.equal(feedback.stepId, 'save'); assert(feedback.prompt.includes(completed.id)); assert(feedback.prompt.includes(completed.fixtureId));
  assert(feedback.prompt.includes(completed.buildVersion)); assert(feedback.prompt.includes(`${completed.id}/save.png`));
  assert.equal((await api(origin, `/api/runs/${newer.id}/feedback`)).length, 0);
  assert.equal((await api(origin, `/api/runs/${completed.id}`)).status, 'passed');
  assert.equal((await api(origin, `/api/runs/${completed.id}`)).acceptance, 'improvements-requested');
  await panel.getByText('Preview task prompt', { exact: true }).click(); await expect(panel.locator('pre')).toContainText(feedback.prompt);
  assert.equal(await (await fetch(`${origin}${await panel.getByRole('link', { name: 'Download task prompt' }).getAttribute('href')}`)).text(), feedback.prompt);
  const position = await panel.boundingBox(), workflow = await page.getByRole('region', { name: 'Test details' }).boundingBox();
  assert(position.y + position.height <= workflow.y, 'Quick review must appear above workflow detail.');
  await page.screenshot({ path: path.join(dataPath, 'quick-review-desktop.png'), fullPage: true });
  report.flows.push({ id: 'QUICK-001', name: 'Pending controls, acceptance/rejection, comment validation and run-pinned feedback during a newer run', status: 'verified', reviewedRun: completed.id, newerRun: newer.id });

  await panel.getByRole('button', { name: 'Prepare Codex job', exact: true }).click();
  await expect(panel).toContainText('Improvement prepared');
  let [job] = await api(origin, '/api/jobs'); assert.equal(job.originalRunId, completed.id); assert.equal(job.status, 'draft');
  await expect(panel.getByRole('button', { name: 'Implement improvement', exact: true })).toBeDisabled();
  const oldPrompt = job.prompt;
  job = await api(origin, `/api/jobs/${job.id}/draft`, { revision: job.revision, prompt: `${oldPrompt}\nConcurrent task revision.` });
  await expect(panel).toContainText('This task changed in another view');
  await expect(panel.getByRole('button', { name: 'Save task', exact: true })).toBeDisabled();
  await panel.getByRole('button', { name: 'Reload task', exact: true }).click();
  await expect(panel.getByLabel('Task prompt', { exact: true })).toHaveValue(job.prompt);
  await panel.getByRole('button', { name: 'Cancel improvement', exact: true }).click();
  await expect.poll(async () => (await api(origin, `/api/jobs/${job.id}`)).status).toBe('cancelled');
  await panel.getByRole('button', { name: 'Review latest run', exact: true }).click();
  await expect(panel.getByRole('link', { name: `Run ${newer.id.slice(0, 8)}`, exact: true })).toBeVisible();
  await expect(panel.getByLabel('What needs improving?', { exact: true })).toHaveValue('');
  await expect(panel.locator('.quick-run-status .badge.pending')).toBeVisible();
  report.flows.push({ id: 'QUICK-002', name: 'Inline prompt export, blocked implementation, concurrent task edits and explicit latest-run switching', status: 'verified', jobId: job.id });

  writer = await createWriterAppContractHost();
  await api(origin, '/api/applications/writerapp/profile', { applicationId: 'writerapp', baseUrl: writer.origin,
    expectedBuildVersion: writer.state.version, expectedUserId: writer.state.userId, isolatedDataConfirmed: true, sourceCommit: 'b'.repeat(40), sourceWasDirty: false });
  const writerRun = await run('writerapp-create-save');
  await page.getByRole('button', { name: 'WriterApp', exact: true }).click();
  await expect(panel.getByRole('link', { name: `Run ${writerRun.id.slice(0, 8)}`, exact: true })).toBeVisible();
  await panel.getByLabel('What needs improving?', { exact: true }).fill('Synthetic fixture confirmation feedback.');
  await panel.getByLabel('Requested outcome', { exact: true }).fill('Clarify the confirmation in the isolated test fixture.');
  await panel.getByRole('button', { name: 'Create improvement task', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Prepare Codex job', exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Prepare Codex job', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Implement improvement', exact: true })).toBeEnabled();
  const draft = (await api(origin, '/api/jobs')).find(j => j.originalRunId === writerRun.id); assert.equal(draft.status, 'draft');
  await panel.getByLabel('Task prompt', { exact: true }).fill(`${draft.prompt}\nPreserve the fixture workflow.`);
  await expect(panel.getByRole('button', { name: 'Implement improvement', exact: true })).toBeDisabled();
  await panel.getByRole('button', { name: 'Save task', exact: true }).click(); await expect(panel.getByRole('status')).toContainText('Task saved');
  await panel.getByRole('button', { name: 'Implement improvement', exact: true }).click();
  await expect(panel.getByRole('status')).toContainText('Implementation queued');
  assert.equal((await api(origin, `/api/jobs/${draft.id}`)).status, 'queued');
  assert.equal((await api(origin, `/api/runs/${writerRun.id}`)).acceptance, 'improvements-requested');
  await panel.getByRole('button', { name: 'Cancel improvement', exact: true }).click();
  assert.equal((await api(origin, `/api/jobs/${draft.id}`)).status, 'cancelled');
  assert.equal((await api(origin, '/api/runs')).length, 3, 'Preparing/queueing an improvement must not fabricate a regression run.');
  await page.setViewportSize({ width: 390, height: 844 }); assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: path.join(dataPath, 'quick-review-mobile.png'), fullPage: true });
  await page.getByRole('button', { name: 'Virtual Company', exact: true }).click();
  await expect(panel).toContainText('Run this test case');
  await page.reload(); await page.getByRole('button', { name: 'WriterApp', exact: true }).click();
  await expect(panel).toContainText('Synthetic fixture confirmation feedback.');
  await expect(panel).toContainText('Cancelled');
  assert.deepEqual(errors, []);
  report.flows.push({ id: 'QUICK-003', name: 'Inline task editing, explicit implementation queue/cancel, per-test selection, persistence and mobile layout', status: 'verified', writerRun: writerRun.id });
  report.issues[0].status = 'verified';
  console.log(`PASS: quick review placement, immutable run/step feedback, acceptance, prompt/job editing, explicit implementation, concurrency and mobile. Evidence: ${dataPath}`);
} finally {
  await browser?.close(); await writer?.close(); await dashboard.stop();
  await writeFile(path.join(dataPath, 'quick-review-report.json'), JSON.stringify(report, null, 2));
}
