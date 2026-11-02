// Synthetic API contract coverage. Live business acceptance is a separate opt-in test.
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { repositoryRoot, api } from '../src/settings.mjs';
import { dashboardHost } from './dashboard-host.mjs';

const data = path.join(repositoryRoot, '.local', `vc-contract-${Date.now()}`); await mkdir(data, { recursive: true });
const runtime = { version: 'contract-1', userId: 'owner-1', companyId: '04040404-0404-0404-0404-040404040404', role: 'owner', isolated: true };
const host = http.createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(runtime)); });
host.listen(0, '127.0.0.1'); await once(host, 'listening');
const dashboard = await dashboardHost(data); const origin = dashboard.origin;
const profile = { applicationId: 'virtual-company', baseUrl: `http://127.0.0.1:${host.address().port}`, expectedBuildVersion: runtime.version,
  expectedUserId: runtime.userId, expectedCompanyId: runtime.companyId, expectedRole: runtime.role, isolatedDataConfirmed: true, sourceCommit: 'a'.repeat(40), sourceWasDirty: false };
let browser;
const reject = async (route, body) => {
  const response = await fetch(`${origin}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(response.status, 400, route);
};
try {
  await reject('/api/runs', { testId: 'virtual-company-workflow' });
  await reject('/api/applications/virtual-company/profile', { ...profile, expectedCompanyId: null });
  await reject('/api/applications/virtual-company/profile', { ...profile, expectedRole: 'employee' });
  await api(origin, '/api/applications/virtual-company/profile', profile);
  for (const [key, wrong] of Object.entries({ version: 'wrong', userId: 'another', companyId: 'different', role: 'employee', isolated: false })) {
    const prior = runtime[key]; runtime[key] = wrong;
    assert.equal((await api(origin, '/api/applications/virtual-company/readiness')).ready, false);
    await reject('/api/runs', { testId: 'virtual-company-workflow' }); runtime[key] = prior;
  }
  assert.equal((await api(origin, '/api/runs')).length, 0);
  const run = await api(origin, '/api/runs', { testId: 'virtual-company-workflow' });
  await api(origin, '/api/applications/virtual-company/profile', { ...profile, expectedBuildVersion: 'future-build' });
  const claim = await api(origin, '/api/worker/claim', {}); assert.equal(claim.run.target.expectedBuildVersion, 'contract-1');
  const directory = path.join(data, 'evidence', run.id); await mkdir(directory, { recursive: true });
  // Registered placeholder files are solely for server validation, never live evidence.
  const steps = [];
  for (const step of run.testSnapshot.steps) {
    await writeFile(path.join(directory, `${step.id}.png`), 'synthetic contract placeholder');
    steps.push({ stepId: step.id, status: 'passed', screenshot: `${run.id}/${step.id}.png` });
  }
  await writeFile(path.join(directory, 'trace.zip'), 'synthetic contract placeholder');
  const completion = { lease: claim.lease, status: 'passed', buildVersion: profile.expectedBuildVersion, baseUrl: profile.baseUrl, steps, trace: `${run.id}/trace.zip`,
    identity: { userId: profile.expectedUserId, evidenceKind: 'live-application', roles: ['owner'], companyId: '05050505-0505-0505-0505-050505050505', isolationCompanyId: profile.expectedCompanyId } };
  for (const invalid of [{ companyId: null }, { companyId: profile.expectedCompanyId }, { isolationCompanyId: null }, { roles: ['employee'] }, { userId: 'other' }])
    await reject(`/api/runs/${run.id}/complete`, { ...completion, identity: { ...completion.identity, ...invalid } });
  const result = await api(origin, `/api/runs/${run.id}/complete`, completion); assert.equal(result.acceptance, 'pending');
  const feedback = await api(origin, `/api/runs/${run.id}/feedback`, { stepId: 'workflow', comment: 'Synthetic contract feedback.', requestedOutcome: 'Preserve the workflow.' });
  assert(feedback.prompt.includes(completion.identity.companyId)); assert(feedback.prompt.includes(profile.expectedCompanyId));
  const draft = await api(origin, '/api/jobs', { runId: run.id, feedbackId: feedback.id }); assert.equal(draft.startBlocker, null);
  await api(origin, `/api/jobs/${draft.id}/cancel`, {});
  browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
  await page.goto(`${origin}/applications`);
  await page.getByLabel('Application', { exact: true }).selectOption('virtual-company');
  await expect(page.getByLabel('Reference company ID')).toHaveValue(profile.expectedCompanyId);
  await expect(page.getByLabel('Clean source commit from launch receipt')).toHaveValue(profile.sourceCommit);
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: path.join(data, 'setup-mobile.png'), fullPage: true });
  console.log(`PASS: Virtual Company setup, runtime mismatch rejection, frozen target, company/role completion validation, feedback provenance and mobile setup. Synthetic evidence: ${data}`);
} finally { await browser?.close(); await dashboard.stop(); await new Promise(resolve => host.close(resolve)); }
