// Actual supervised worker and Playwright, disposable dashboard/demo only.
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { chromium, expect } from '@playwright/test';
import { api, repositoryRoot } from '../src/settings.mjs';
import { cleanEnvironment, runCommand } from '../src/processes.mjs';
import { dashboardHost } from './dashboard-host.mjs';

const dataPath = path.join(repositoryRoot, '.local', `worker-launch-${Date.now()}`), dashboard = await dashboardHost(dataPath);
const report = { scope: 'Actual supervised worker with disposable demo; no Codex/application/provider execution', flows: [], issues: [] };
const environment = { ...cleanEnvironment(), GETRIGHT_DASHBOARD_URL: dashboard.origin, GETRIGHT_DATA_PATH: dataPath, GETRIGHT_HEADLESS: 'true', GETRIGHT_KEEP_BROWSER_OPEN: 'false' };
const launch = () => runCommand(process.execPath, [fileURLToPath(new URL('../src/launch.mjs', import.meta.url)), '--once'], { env: environment, signal: AbortSignal.timeout(20000), allowFailure: true });
let browser;
try {
  const empty = await launch(); assert.equal(empty.code, 0, empty.output); assert.match(empty.output, /No queued tests/);
  browser = await chromium.launch({ headless: true }); const page = await browser.newPage(); await page.goto(dashboard.origin);
  const demo = (await api(dashboard.origin, '/api/catalog')).tests.find(test => test.id === 'getright-save-note');
  await page.locator('.test-card').filter({ has: page.getByRole('button', { name: demo.title, exact: true }) }).getByRole('button', { name: /^Run UAT test/ }).click();
  const casePanel = page.getByRole('region', { name: 'Test case in this run' });
  await expect(casePanel).toContainText('Waiting for the local worker');
  const [queued] = await api(dashboard.origin, '/api/runs'); assert.equal(queued.status, 'queued');
  await expect(page).toHaveURL(`${dashboard.origin}/runs/${queued.id}/watch`);
  const executed = await launch(); assert.equal(executed.code, 0, executed.output); assert.match(executed.output, /Result: passed/);
  const result = await api(dashboard.origin, `/api/runs/${queued.id}`); assert.equal(result.status, 'passed', result.error); assert.equal(result.acceptance, 'pending');
  const acceptance = page.getByRole('region', { name: 'Human acceptance' });
  await expect(acceptance.getByRole('button', { name: 'Accept this run', exact: true })).toBeEnabled({ timeout: 10000 });
  await expect(acceptance).toContainText('Passed');
  await expect(casePanel).not.toContainText('Waiting for the local worker');
  report.flows.push({ id: 'WORKER-001', name: 'Actual empty and queued --once child exits without an IPC hang; demo evidence saved with pending acceptance', status: 'verified', runId: result.id });
  // A bad local source path fails before any Codex, worktree or application build.
  // The real CLI must explain the result and link the immutable attempt.
  const caseId = randomUUID().replaceAll('-', ''), testId = `draft-${caseId}`, now = new Date().toISOString();
  const test = { id: testId, applicationId: 'virtual-company', title: 'Disposable missing source receipt', purpose: 'Verify worker failure diagnostics.', readiness: 'draft', adapter: null,
    preconditions: 'Synthetic isolated source.', reviewQuestion: 'Is the failure clear?', steps: [{ id: 'step-1', title: 'Open controls', expected: 'Controls are visible.' }] };
  const job = { id: caseId, testId, applicationId: 'virtual-company', status: 'queued', testSnapshot: test, definitionDigest: 'a'.repeat(64), approvedTarget: null, createdAt: now, updatedAt: now };
  const db = new DatabaseSync(path.join(dataPath, 'getright.db'));
  db.prepare('INSERT INTO case_implementation_jobs(id,test_id,payload) VALUES(?,?,?)').run(caseId, testId, JSON.stringify(job)); db.close();
  const configPath = path.join(dataPath, 'worker.local.json');
  await writeFile(configPath, JSON.stringify({ 'virtual-company': { repositoryPath: path.join(dataPath, 'missing-application-source') } }));
  const failed = await runCommand(process.execPath, [fileURLToPath(new URL('../src/launch.mjs', import.meta.url)), '--once'], {
    env: { ...environment, GETRIGHT_WORKER_CONFIG: configPath }, signal: AbortSignal.timeout(20000), allowFailure: true,
  });
  assert.equal(failed.code, 1, failed.output); assert.match(failed.output, /Test implementation: failed/); assert.match(failed.output, /Reason: .*ENOENT/);
  assert(failed.output.includes(`Details: ${dashboard.origin}/case-implementations/${caseId}`));
  const storedFailure = await api(dashboard.origin, `/api/case-implementations/${caseId}`); assert.equal(storedFailure.status, 'failed'); assert.equal(storedFailure.validationRunIds, null);
  assert.equal((await api(dashboard.origin, `/api/runs/${queued.id}`)).acceptance, 'pending');
  report.flows.push({ id: 'WORKER-002', name: 'Actual failed implementation reports its reason/detail URL and exits once without Codex/builds or changing run acceptance', status: 'verified' });
  console.log(`PASS: supervised worker --once lifecycle, demo execution and independent acceptance. Evidence: ${dataPath}`);
} finally { await browser?.close(); await dashboard.stop(); await writeFile(path.join(dataPath, 'worker-launch-report.json'), JSON.stringify(report, null, 2)); }
