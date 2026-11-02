// Opt-in: real Codex creates a bounded note workflow and local Git commit.
// --virtual-company additionally builds the real app and validates an explicit
// synthetic plan against it; the VC case uses a synthetic compiler, not Codex.
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { chromium, expect } from '@playwright/test';
import { api, repositoryRoot } from '../src/settings.mjs';
import { dashboardHost } from './dashboard-host.mjs';
import { executeCaseImplementation } from '../src/case-implementation.mjs';
import { executeRun } from '../src/runner.mjs';
import { workflowEngineDigest } from '../src/workflow-engine.mjs';

const dataPath = path.join(repositoryRoot, '.local', `case-live-${Date.now()}`); await mkdir(dataPath, { recursive: true });
const dashboard = await dashboardHost(dataPath), origin = dashboard.origin;
const configuration = { dashboardUrl: origin, dataPath, headless: true };
let browser;
const report = { scope: 'Actual Codex draft-to-runnable proof; optional real VC with synthetic plan compiler', flows: [] };
function seed(applicationId, title, steps) {
  const id = `draft-${randomUUID().replaceAll('-', '')}`;
  const test = { id, applicationId, title, purpose: 'Verify saving unique fixture content and reopening it.', readiness: 'draft', adapter: null,
    reviewQuestion: 'Is the saved state clear?', preconditions: 'Fresh isolated fixture; no production accounts, email transport or external providers.', generationId: null, steps };
  const db = new DatabaseSync(path.join(dataPath, 'getright.db'));
  db.prepare('INSERT INTO draft_test_cases(id,suite_id,payload) VALUES(?,?,?)').run(id, `${applicationId}-suite`, JSON.stringify(test)); db.close(); return test;
}
async function approve(test) {
  await browser?.close(); browser = await chromium.launch({ headless: true }); const page = await browser.newPage(); await page.goto(origin);
  await page.getByRole('button', { name: test.title, exact: true }).click();
  await page.getByRole('button', { name: 'Approve and implement test case', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Test case implementation' })).toContainText('Case approved and queued');
  return (await api(origin, `/api/case-implementations?test=${test.id}`))[0];
}
try {
  const test = seed('getright', 'Live implementation: save and reopen a unique note', [
    { id: 'step-1', title: 'Enter a unique title and body, then save the note', expected: 'The visible confirmation says the note was saved successfully.' },
    { id: 'step-2', title: 'Reload the note page', expected: 'The same unique title and body are retained after reload.' },
  ]);
  const approved = await approve(test); console.log(`Running real Codex implementation ${approved.id}.`);
  const result = await executeCaseImplementation(await api(origin, '/api/worker/case-implementations/claim', {}), configuration);
  assert.equal(result.status, 'verified', result.error); assert.equal(result.validationRunIds.length, 2);
  const next = await api(origin, '/api/runs', { testId: test.id });
  const completed = await executeRun(await api(origin, '/api/worker/claim', { workflowEngineDigest }), configuration);
  assert.equal(completed.id, next.id); assert.equal(completed.status, 'passed', completed.error); assert.equal(completed.acceptance, 'pending');
  report.flows.push({ application: 'getright', compiler: 'real Codex SDK', job: result, rerunId: completed.id, acceptance: completed.acceptance });
  if (process.argv.includes('--virtual-company')) {
    const readiness = await api('http://127.0.0.1:5120', '/api/applications/virtual-company/readiness'); assert(readiness.ready, readiness.message);
    const profile = await api('http://127.0.0.1:5120', '/api/applications/virtual-company/profile');
    await api(origin, '/api/applications/virtual-company/profile', profile);
    const company = seed('virtual-company', 'Live implementation: save and reopen draft-only company permissions', [
      { id: 'step-1', title: 'Open the prepared test company controls', expected: 'The company policy is available and send permission is off.' },
      { id: 'step-2', title: 'Choose draft permission, the disconnected sender, and a unique recipient', expected: 'The draft selection and recipient appear in the form.' },
      { id: 'step-3', title: 'Save the permissions', expected: 'Permissions saved confirmation appears.' },
      { id: 'step-4', title: 'Reload the controls', expected: 'Draft permission, sender and recipient persist; sending remains off.' },
    ]);
    await approve(company);
    const draft = 'label:has-text("Allow provider drafts") input', send = 'label:has-text("Allow sending test emails") input', sender = '.test-policy label:has-text("getright-sender@example.invalid") input';
    const plan = { version: 1, fixture: 'virtual-company-test-company', entryPath: '/settings/test-company?companyId={{companyId}}', reviewPath: '/test-companies/new', steps: [
      { stepId: 'step-1', actions: [{ kind: 'expect-visible', selector: '.test-policy h2' }, { kind: 'expect-unchecked', selector: send }] },
      { stepId: 'step-2', actions: [{ kind: 'check', selector: draft }, { kind: 'fill', selector: '#test-recipients', value: '{{email}}' }, { kind: 'check', selector: sender }, { kind: 'expect-checked', selector: draft }, { kind: 'expect-value', selector: '#test-recipients', value: '{{email}}' }] },
      { stepId: 'step-3', actions: [{ kind: 'click', selector: '.test-policy button[type=submit]' }, { kind: 'expect-visible', selector: '[role=status]:has-text("Permissions saved.")' }] },
      { stepId: 'step-4', actions: [{ kind: 'reload' }, { kind: 'expect-checked', selector: draft }, { kind: 'expect-unchecked', selector: send }, { kind: 'expect-checked', selector: sender }, { kind: 'expect-value', selector: '#test-recipients', value: '{{email}}' }] },
    ] };
    const verified = await executeCaseImplementation(await api(origin, '/api/worker/case-implementations/claim', {}), configuration, { implement: async ({ worktree, report }) => {
      await report('Explicit synthetic plan compiler; validation uses the real Virtual Company build.', { threadId: 'synthetic-compiler-real-vc' });
      const file = path.join(worktree, 'config/implemented-tests', `${company.id}.json`); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(plan, null, 2)); return { threadId: 'synthetic-compiler-real-vc' };
    } });
    assert.equal(verified.status, 'verified', verified.error);
    const runs = await Promise.all(verified.validationRunIds.map(id => api(origin, `/api/runs/${id}`)));
    assert(runs.every(r => r.status === 'passed' && r.acceptance === 'pending')); assert.notEqual(runs[0].identity.companyId, runs[1].identity.companyId);
    report.flows.push({ application: 'virtual-company', compiler: 'synthetic plan compiler', runtime: 'actual clean build and real Web/API services with fresh SQLite fixtures', job: verified });
  }
  console.log(`PASS: actual Codex test implementation and verified pending-acceptance rerun. Evidence: ${dataPath}`);
} finally {
  await writeFile(path.join(dataPath, 'live-report.json'), JSON.stringify(report, null, 2)); await browser?.close(); await dashboard.stop();
}
