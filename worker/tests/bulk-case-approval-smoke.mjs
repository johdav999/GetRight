// Disposable dashboard and cases; queues approvals without invoking Codex.
import assert from 'node:assert/strict';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { chromium, expect } from '@playwright/test';
import { api, repositoryRoot } from '../src/settings.mjs';
import { dashboardHost } from './dashboard-host.mjs';

const dataPath = path.join(repositoryRoot, '.local', `bulk-case-approval-${Date.now()}`);
const dashboard = await dashboardHost(dataPath), origin = dashboard.origin;
let browser, runtimeRequests = 0;
const company = http.createServer(async (req, res) => {
  if (req.url !== '/_getright/runtime') { res.writeHead(404); res.end(); return; }
  runtimeRequests++;
  res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ version: 'wrong-build' }));
});
company.listen(0, '127.0.0.1'); await once(company, 'listening');
function seed(title, applicationId = 'getright') {
  const id = `draft-${randomUUID().replaceAll('-', '')}`;
  const test = { id, applicationId, title, purpose: 'Synthetic bulk approval fixture.', readiness: 'draft', adapter: null,
    reviewQuestion: 'Is the outcome clear?', preconditions: 'Disposable isolated data.',
    steps: [{ id: 'step-1', title: 'Save synthetic content', expected: 'Saved content is visible.' }] };
  const db = new DatabaseSync(path.join(dataPath, 'getright.db'));
  db.prepare('INSERT INTO draft_test_cases(id,suite_id,payload) VALUES(?,?,?)').run(id, `${applicationId}-suite`, JSON.stringify(test));
  const suite = JSON.parse(db.prepare('SELECT payload FROM test_suites WHERE id=?').get(`${applicationId}-suite`).payload); suite.testIds.push(id);
  db.prepare('UPDATE test_suites SET payload=? WHERE id=?').run(JSON.stringify(suite), suite.id); db.close(); return test;
}
const report = { scope: 'Bulk draft approval UI, disposable SQLite; no Codex or application mutations', flows: [], issues: [] };
const jobs = () => api(origin, '/api/case-implementations');
try {
  const a = seed('Already approved note'), b = seed('Suite-scoped pending note'), c = seed('Other pending note');
  const blocked = seed('Wrong-build company draft', 'virtual-company');
  const suite = await api(origin, '/api/suites', { applicationId: 'getright', name: 'Only the selected note', description: 'Bulk scope fixture.', testIds: [b.id] });
  const catalog = JSON.parse(await readFile(path.join(repositoryRoot, 'config/catalog.json'), 'utf8'));
  const runId = randomUUID().replaceAll('-', '');
  const legacy = { id: runId, testId: catalog.tests[0].id, applicationId: 'getright', status: 'passed', acceptance: 'pending', createdAt: new Date().toISOString(), completedAt: new Date().toISOString(), fixtureId: `uat-${runId}`, buildVersion: 'synthetic-history', steps: [], testSnapshot: catalog.tests[0] };
  const db = new DatabaseSync(path.join(dataPath, 'getright.db')); db.prepare('INSERT INTO runs(id,payload) VALUES(?,?)').run(runId, JSON.stringify(legacy)); db.close();
  const retained = await api(origin, `/api/runs/${runId}`);
  await api(origin, '/api/applications/virtual-company/profile', { applicationId: 'virtual-company', baseUrl: `http://127.0.0.1:${company.address().port}`,
    expectedBuildVersion: 'approved-build', expectedUserId: 'synthetic-owner', expectedCompanyId: '04040404-0404-0404-0404-040404040404', expectedRole: 'owner', isolatedDataConfirmed: true, sourceCommit: null, sourceWasDirty: false });
  browser = await chromium.launch({ headless: true }); const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const bulk = page.getByRole('region', { name: 'Bulk test case approval', exact: true });
  const approve = () => bulk.getByRole('button', { name: /^Approve all pending test cases/ });
  await page.goto(origin+'/?view=generation'); await page.getByRole('button', { name: a.title, exact: true }).click();
  await page.getByRole('button', { name: 'Approve and implement test case', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Test case implementation', exact: true })).toContainText('Case approved and queued');
  const [originalJob] = await jobs(); assert.equal(originalJob.testId, a.id);
  await page.getByRole('button', { name: 'Getright demo', exact: true }).click();
  await expect(approve()).toHaveText('Approve all pending test cases (2)');
  await expect(bulk).toContainText('1 case is already queued');
  await page.getByLabel('Test suite', { exact: true }).selectOption(suite.id);
  await expect(approve()).toHaveText('Approve all pending test cases (1)'); await approve().click();
  await expect(bulk.getByRole('status')).toHaveText('1 queued for implementation; 0 could not be approved; 0 left unprocessed.');
  await expect(approve()).toBeDisabled();
  let current = await jobs(); assert.equal(current.length, 2); assert(current.some(j => j.testId === b.id)); assert(!current.some(j => j.testId === c.id));
  assert.equal(current.find(j => j.testId === a.id).id, originalJob.id);
  report.flows.push({ id: 'BULK-001', name: 'Application/suite scope, skip already active, disable empty batch and prevent duplicate approval', status: 'verified' });

  await page.getByRole('button', { name: 'All applications', exact: true }).click();
  await expect(approve()).toHaveText('Approve all pending test cases (6)');
  await approve().click();
  await expect(bulk.getByRole('status')).toHaveText('1 queued for implementation; 5 could not be approved; 0 left unprocessed.');
  const later = seed('Added after the bulk click');
  await page.getByRole('button', { name: 'Getright demo', exact: true }).click();
  await bulk.getByText('Last batch:', { exact: false }).click();
  await expect(bulk).toContainText('Configure an isolated application launch receipt first.');
  await expect(bulk).toContainText('Import a clean committed');
  assert.equal(runtimeRequests, 0, 'Definition approval must not depend on a manual host.');
  current = await jobs(); assert.equal(current.length, 3); assert(current.some(j => j.testId === c.id));
  assert(!current.some(j => [blocked.id, later.id].includes(j.testId)));
  assert.equal(current.filter(j => j.testId === a.id).length, 1);
  assert.deepEqual(await api(origin, `/api/runs/${runId}`), retained); assert.equal((await api(origin, '/api/runs')).length, 1);
  const definitions = (await api(origin, '/api/catalog')).tests;
  for (const test of [a, b, c, blocked, later]) assert.equal(definitions.find(t => t.id === test.id).readiness, 'draft');
  await page.screenshot({ path: path.join(dataPath, 'bulk-approval-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(approve()).toBeEnabled(); assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: path.join(dataPath, 'bulk-approval-mobile.png'), fullPage: true });
  const profile = await api(origin, '/api/applications/virtual-company/profile');
  await api(origin, '/api/applications/virtual-company/profile', { ...profile, sourceCommit: 'a'.repeat(40) });
  await page.getByRole('button', { name: 'Virtual Company', exact: true }).click();
  await expect(approve()).toHaveText('Approve all pending test cases (1)'); await approve().click();
  await expect(bulk.getByRole('status')).toHaveText('1 queued for implementation; 0 could not be approved; 0 left unprocessed.');
  const companyJob = (await jobs()).find(j => j.testId === blocked.id); assert(companyJob); assert.equal((await jobs()).length, 4);
  assert.equal(runtimeRequests, 0, 'Approval must not use an unrelated current runtime/build.');
  assert.equal((await api(origin, '/api/applications/virtual-company/readiness')).ready, false, 'Running/opening the manual app must still check its build.');
  await new Promise(resolve => company.close(resolve));
  await api(origin, `/api/case-implementations/${companyJob.id}/cancel`, {});
  await approve().click(); await expect(bulk.getByRole('status')).toContainText('1 queued for implementation');
  assert.equal((await jobs()).length, 5, 'A clean receipt can be approved while its old host is entirely stopped.');
  const [offlineJob] = await jobs();
  await api(origin, '/api/applications/virtual-company/profile', { ...profile, sourceCommit: 'a'.repeat(40), sourceWasDirty: true });
  const dirty = await fetch(`${origin}/api/tests/${blocked.id}/approve-implementation`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ definitionDigest: offlineJob.definitionDigest }) });
  assert.equal(dirty.status, 400); assert.match(await dirty.text(), /clean committed/);
  await api(origin, '/api/applications/virtual-company/profile', { ...profile, sourceCommit: 'a'.repeat(40), sourceWasDirty: false });
  const stale = await fetch(`${origin}/api/tests/${blocked.id}/approve-implementation`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ definitionDigest: 'stale' }) });
  assert.equal(stale.status, 400); assert.equal((await jobs()).length, 5);
  assert.equal((await api(origin, '/api/catalog')).tests.find(t => t.id === blocked.id).readiness, 'draft');
  assert.deepEqual(await api(origin, `/api/runs/${runId}`), retained);
  assert.deepEqual(errors, []);
  report.flows.push({ id: 'BULK-002', name: 'Missing clean receipts fail per case; wrong-build/stopped manual hosts do not prevent approval; runtime readiness and pending acceptance remain independent', status: 'verified' });
  console.log(`PASS: bulk/offline approval, clean-receipt and definition guards, deduplication, partial failures, pending acceptance and desktop/mobile. Evidence: ${dataPath}`);
} finally {
  await browser?.close(); await dashboard.stop(); if (company.listening) await new Promise(resolve => company.close(resolve));
  await writeFile(path.join(dataPath, 'bulk-approval-report.json'), JSON.stringify(report, null, 2));
}
