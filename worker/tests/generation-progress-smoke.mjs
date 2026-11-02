// Disposable SQLite worker-status fixtures and real dashboard UI. No Codex runs.
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { chromium, expect } from '@playwright/test';
import { api, repositoryRoot } from '../src/settings.mjs';
import { dashboardHost } from './dashboard-host.mjs';

const dataPath = path.join(repositoryRoot, '.local', `generation-progress-${Date.now()}`);
const dashboard = await dashboardHost(dataPath), origin = dashboard.origin;
const id = () => randomUUID().replaceAll('-', '');
const db = () => new DatabaseSync(path.join(dataPath, 'getright.db'));
const seed = title => {
  const test = { id: `draft-${id()}`, applicationId: 'getright', title, purpose: 'Synthetic progress presentation fixture.', readiness: 'draft', adapter: null,
    reviewQuestion: 'Is progress clear?', preconditions: 'Disposable fixture.', steps: [{ id: 'step-1', title: 'Review the note', expected: 'The note title is visible.' }] };
  const connection = db(); connection.prepare('INSERT INTO draft_test_cases(id,suite_id,payload) VALUES(?,?,?)').run(test.id, 'getright-suite', JSON.stringify(test)); connection.close(); return test;
};
function patch(job, changes, message) {
  Object.assign(job, changes, { updatedAt: new Date().toISOString() });
  const connection = db(); connection.prepare('UPDATE case_implementation_jobs SET payload=? WHERE id=?').run(JSON.stringify(job), job.id);
  if (message) connection.prepare('INSERT INTO case_implementation_events(job_id,created_at,stage,message) VALUES(?,?,?,?)').run(job.id, job.updatedAt, job.status, message);
  connection.close();
}
function validation(job, status) {
  const runId = id(), now = new Date().toISOString();
  const run = { id: runId, testId: job.testId, applicationId: 'getright', status, acceptance: 'pending', createdAt: now, startedAt: now,
    completedAt: status === 'passed' ? now : null, fixtureId: `uat-${runId}`, buildVersion: 'synthetic-progress-fixture', steps: [], testSnapshot: job.testSnapshot, caseImplementationJobId: job.id };
  const connection = db(); connection.prepare('INSERT INTO runs(id,payload) VALUES(?,?)').run(run.id, JSON.stringify(run)); connection.close(); return run;
}
function enable(job) {
  const plan = JSON.stringify({ version: 1, fixture: 'getright-note', entryPath: '/uat-fixture.html?fixture={{fixtureId}}', reviewPath: '/uat-fixture.html', steps: [{ stepId: 'step-1', actions: [{ kind: 'expect-visible', selector: '#title' }] }] });
  const binding = { jobId: job.id, definitionDigest: job.definitionDigest, planJson: plan, planDigest: createHash('sha256').update(plan).digest('hex'), engineDigest: 'a'.repeat(64),
    platformBaseCommit: 'a'.repeat(40), resultCommit: 'b'.repeat(40), applicationSourceCommit: null, validationRunIds: job.validationRunIds, verifiedAt: new Date().toISOString() };
  const connection = db(); connection.prepare('INSERT INTO case_bindings(test_id,job_id,payload) VALUES(?,?,?)').run(job.testId, job.id, JSON.stringify(binding)); connection.close();
}
const report = { scope: 'Generation progress UI with synthetic worker status fixtures; no execution/acceptance claims', flows: [], issues: [] };
let browser;
try {
  browser = await chromium.launch({ headless: true }); const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const panel = page.getByRole('region', { name: 'Test case generation progress', exact: true });
  await page.goto(origin); await expect(panel).toContainText('No test implementations yet in this view.');
  const cases = ['Queued case', 'Active case', 'Failed case', 'Interrupted case', 'Cancelled case', 'Verified case', 'Disabled case', 'Retried case'].map(seed);
  await page.getByRole('button', { name: 'Refresh results', exact: true }).click();
  await page.getByRole('button', { name: 'Getright demo', exact: true }).click();
  await page.getByRole('button', { name: /^Approve all pending test cases/ }).click();
  await expect(page.getByRole('region', { name: 'Bulk test case approval', exact: true }).getByRole('status')).toContainText('8 queued');
  const approved = await api(origin, '/api/case-implementations');
  const jobs = cases.map(test => approved.find(j => j.testId === test.id)); assert(jobs.every(Boolean));
  await expect(panel).toContainText('Waiting for the local worker to pick up 8 cases.');
  patch(jobs[1], { status: 'preparing' }); patch(jobs[2], { status: 'failed', error: 'Missing isolated invoice fixture.' });
  patch(jobs[3], { status: 'interrupted', error: 'Worker lease expired.' }); patch(jobs[4], { status: 'cancelled', error: 'Cancelled before execution.' });
  for (const job of [jobs[5], jobs[6]]) { const runs = [validation(job, 'passed'), validation(job, 'passed')]; patch(job, { status: 'verified', validationRunIds: runs.map(r => r.id) }); enable(job); }
  await api(origin, `/api/tests/${jobs[6].testId}/disable-implementation`, {});
  // Older jobs and logs must not hide other cases or the latest event behind
  // the ordinary 100-job/200-event history page limits.
  patch(jobs[7], { status: 'failed' });
  const history = db(); const insert = history.prepare('INSERT INTO case_implementation_jobs(id,test_id,payload) VALUES(?,?,?)');
  for (let index = 0; index < 110; index++) { const older = { ...jobs[7], id: id(), status: 'failed' }; insert.run(older.id, older.testId, JSON.stringify(older)); }
  const retry = { ...jobs[7], id: id(), status: 'queued' }; insert.run(retry.id, retry.testId, JSON.stringify(retry));
  const event = history.prepare('INSERT INTO case_implementation_events(job_id,created_at,stage,message) VALUES(?,?,?,?)');
  for (let index = 0; index < 241; index++) event.run(jobs[1].id, new Date().toISOString(), 'preparing', `Synthetic worker progress ${index}`);
  history.close();
  await expect(panel.locator('.generation-case')).toHaveCount(8, { timeout: 10000 });
  await expect(panel.locator('.generation-completion')).toHaveText('5 of 8 implementations finished · 1 ready to run', { timeout: 10000 });
  await expect(panel.getByRole('progressbar')).toHaveAttribute('value', '5'); await expect(panel.getByRole('progressbar')).toHaveAttribute('max', '8');
  const row = test => panel.locator('.generation-case').filter({ has: page.getByRole('link', { name: test.title, exact: true }) });
  await expect(row(cases[0])).toContainText('Queued'); await expect(row(cases[1])).toContainText('Synthetic worker progress 240');
  await expect(row(cases[2])).toContainText('Missing isolated invoice fixture.'); await expect(row(cases[3])).toContainText('Worker lease expired.');
  await expect(row(cases[5]).locator('.badge')).toHaveText('Ready'); await expect(row(cases[6]).locator('.badge')).toHaveText('Verified');
  await expect(row(cases[6])).toContainText('Automation is disabled or needs reverification');
  await expect(row(cases[5])).toContainText('2/2 validations passed');
  await expect(row(cases[7]).getByRole('link', { name: cases[7].title, exact: true })).toHaveAttribute('href', `/case-implementations/${retry.id}`);
  report.flows.push({ id: 'PROGRESS-001', name: 'Rollup includes failed/cancelled outcomes without false readiness; latest jobs/events beyond history limits; disabled bindings and proof links', status: 'verified' });

  for (const [stage, label] of [['building', 'Building'], ['implementing', 'Generating automation']]) {
    patch(jobs[1], { status: stage }, `Now ${stage}.`);
    await expect(row(cases[1]).locator('.badge')).toHaveText(label, { timeout: 10000 });
    await expect(row(cases[1])).toContainText(`Now ${stage}.`);
  }
  const first = validation(jobs[1], 'passed'), second = validation(jobs[1], 'running');
  patch(jobs[1], { status: 'validating', validationRunIds: [first.id, second.id] }, 'Second fresh fixture is running.');
  await expect(row(cases[1])).toContainText('1/2 validations passed', { timeout: 10000 });
  await expect(row(cases[1])).toContainText('Validation 2: Running');
  const connection = db(); second.status = 'passed'; second.completedAt = new Date().toISOString(); connection.prepare('UPDATE runs SET payload=? WHERE id=?').run(JSON.stringify(second), second.id); connection.close();
  patch(jobs[1], { status: 'verified' }, 'Both validation fixtures passed.'); enable(jobs[1]);
  await expect(panel.locator('.generation-completion')).toHaveText('6 of 8 implementations finished · 2 ready to run', { timeout: 10000 });
  const beforeRuns = await api(origin, '/api/runs'); assert(beforeRuns.every(r => r.acceptance === 'pending'));
  await page.screenshot({ path: path.join(dataPath, 'progress-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 }); await expect(panel).toBeVisible();
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: path.join(dataPath, 'progress-mobile.png'), fullPage: true });
  const suite = await api(origin, '/api/suites', { applicationId: 'getright', name: 'Only a verified case', description: 'Progress scope fixture.', testIds: [cases[5].id] });
  await page.getByRole('button', { name: 'Refresh results', exact: true }).click(); await page.getByLabel('Test suite', { exact: true }).selectOption(suite.id);
  await expect(panel.locator('.generation-completion')).toHaveText('1 of 1 implementations finished · 1 ready to run');
  await expect(panel.locator('.generation-case')).toHaveCount(1);
  await page.getByRole('button', { name: 'Virtual Company', exact: true }).click(); await expect(panel).toContainText('No test implementations yet in this view.');
  await page.getByRole('button', { name: 'All applications', exact: true }).click(); await expect(panel.locator('.generation-case')).toHaveCount(8);
  assert.deepEqual(await api(origin, '/api/runs'), beforeRuns); assert.deepEqual(errors, []);
  report.flows.push({ id: 'PROGRESS-002', name: 'Live preparing/building/generating/validating/verified transitions; suite/application scope; desktop/mobile and unchanged human acceptance', status: 'verified' });
  console.log(`PASS: live case generation progress, counts, stages, validation links, history limits, filters and mobile. Evidence: ${dataPath}`);
} finally { await browser?.close(); await dashboard.stop(); await writeFile(path.join(dataPath, 'progress-report.json'), JSON.stringify(report, null, 2)); }
