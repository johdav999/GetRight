// Real SQLite/dashboard/browser with a synthetic OpenAI HTTP contract and target.
// Never calls a paid provider or executes generated test cases.
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { chromium, expect } from '@playwright/test';
import { api, repositoryRoot } from '../src/settings.mjs';
import { dashboardHost } from './dashboard-host.mjs';

const data = path.join(repositoryRoot, '.local', `suites-${Date.now()}`); await mkdir(data, { recursive: true });
const catalog = JSON.parse(await readFile(path.join(repositoryRoot, 'config/catalog.json'), 'utf8'));
const legacyId = 'a'.repeat(32), legacy = { id: legacyId, testId: catalog.tests[0].id, applicationId: 'getright',
  status: 'passed', acceptance: 'accepted', createdAt: new Date().toISOString(), completedAt: new Date().toISOString(),
  fixtureId: `uat-${legacyId}`, buildVersion: 'previous-build', steps: [], testSnapshot: catalog.tests[0] };
const db = new DatabaseSync(path.join(data, 'getright.db'));
db.exec(`CREATE TABLE runs(id TEXT PRIMARY KEY,payload TEXT NOT NULL,lease TEXT,lease_expires TEXT);
CREATE TABLE feedback(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id),payload TEXT NOT NULL);
CREATE TABLE application_profiles(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
CREATE TABLE improvement_jobs(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id),feedback_id TEXT NOT NULL REFERENCES feedback(id),payload TEXT NOT NULL,lease TEXT,lease_expires TEXT);
CREATE TABLE job_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,job_id TEXT NOT NULL REFERENCES improvement_jobs(id),created_at TEXT NOT NULL,stage TEXT NOT NULL,message TEXT NOT NULL);
CREATE TABLE review_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT NOT NULL REFERENCES runs(id),created_at TEXT NOT NULL,action TEXT NOT NULL,previous TEXT NOT NULL,current TEXT NOT NULL,feedback_id TEXT);
CREATE TABLE cleanup_tasks(id TEXT PRIMARY KEY,payload TEXT NOT NULL,lease TEXT,lease_expires TEXT); PRAGMA user_version=4;`);
db.prepare('INSERT INTO runs(id,payload) VALUES(?,?)').run(legacyId, JSON.stringify(legacy)); db.close();
let mode = 'success', requestCount = 0, release, mutationCount = 0;
const runtime = { version: 'contract-1', userId: 'owner-1', companyId: '04040404-0404-0404-0404-040404040404', role: 'owner', isolated: true };
const proposed = index => ({ title: `Permission case ${index + 1}`, purpose: 'Verify the described draft permission behavior.',
  preconditions: 'An isolated company, synthetic owner and employee, and a disconnected mailbox fixture.',
  reviewQuestion: 'Can the owner understand and verify the permission setting?',
  steps: [{ action: 'Open the company controls as the owner.', expected: 'Draft permissions are visible.' },
    { action: 'Save permissions and reload.', expected: 'The saved draft-only permissions remain visible.' }] });
const provider = http.createServer(async (req, res) => {
  let raw = ''; for await (const part of req) raw += part;
  const body = JSON.parse(raw); requestCount++;
  assert.equal(req.url, '/v1/responses'); assert.equal(req.headers.authorization, 'Bearer contract-test-key');
  assert.equal(body.store, false); assert.equal(body.text.format.type, 'json_schema'); assert.equal(body.text.format.strict, true);
  assert.equal(body.text.format.schema.additionalProperties, false);
  const input = JSON.parse(body.input); assert.equal(input.application, 'Virtual Company'); assert(input.feature); assert(input.suite);
  assert.deepEqual(Object.keys(input).sort(), ['application', 'count', 'feature', 'suite']);
  assert.equal(body.text.format.schema.properties.cases.minItems, input.count);
  if (mode === 'hold') await new Promise(resolve => { release = resolve; });
  if (mode === 'timeout' || mode === 'cancel') { const timer = setTimeout(() => res.end('{}'), 2500); res.once('close', () => clearTimeout(timer)); return; }
  if (['401', '429', '503'].includes(mode)) { res.writeHead(Number(mode)); res.end('provider-private-details'); return; }
  const cases = Array.from({ length: input.count }, (_, i) => proposed(i));
  if (mode === 'wrong-count') cases.pop();
  if (mode === 'unsafe-field') cases[0].adapter = 'virtual-company-test-setup';
  if (mode === 'null-steps') cases[0].steps = null;
  if (mode === 'blank-title') cases[0].title = ' ';
  const content = mode === 'refusal' ? [{ type: 'refusal', refusal: 'Synthetic refusal.' }] : [{ type: 'output_text', text: JSON.stringify({ cases }) }];
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ id: `response-contract-${requestCount}`, model: 'contract-model', status: mode === 'incomplete' ? 'incomplete' : 'completed', output: [{ type: 'message', content }] }));
});
provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
const company = http.createServer((req, res) => {
  if (req.method !== 'GET') mutationCount++;
  if (req.url === '/_getright/runtime') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(runtime)); }
  else { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><h1>Synthetic test company creation</h1><input aria-label="Company name">'); }
});
company.listen(0, '127.0.0.1'); await once(company, 'listening');
const environment = { OPENAI_API_KEY: 'contract-test-key', Getright__OpenAI__Model: 'contract-model',
  Getright__OpenAI__Endpoint: `http://127.0.0.1:${provider.address().port}/v1/responses`, Getright__OpenAI__TimeoutSeconds: '1' };
const dashboard = await dashboardHost(data, { environment }), origin = dashboard.origin;
let browser, noKey;
const report = { scope: 'Suites, proposals and open-page UAT; synthetic HTTP providers', flows: [], issues: [
  { id: 'SUITE-UAT-001', severity: 'P2', flow: 'Suite filtering', observed: 'Filtering the dropdown options during selection left its label showing All suites while a suite was active.', expected: 'The selected suite label and case list agree.', status: 'open' },
  { id: 'SUITE-UAT-002', severity: 'P2', flow: 'Suite form editing', observed: 'Fast edits followed by membership interaction could lose an uncommitted textarea value.', expected: 'Input updates are retained while changing suite membership.', status: 'open' },
] };
const reject = async (route, body, expected = /./) => {
  const response = await fetch(`${origin}${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
  assert.equal(response.status, 400, route); const text = await response.text(); assert.match(text, expected); assert(!text.includes('provider-private-details')); return text;
};
try {
  const restored = await api(origin, `/api/runs/${legacyId}`);
  assert.equal(restored.acceptance, legacy.acceptance); assert.equal(restored.buildVersion, legacy.buildVersion);
  assert.equal(Date.parse(restored.createdAt), Date.parse(legacy.createdAt));
  const migrated = new DatabaseSync(path.join(data, 'getright.db')); assert.equal(migrated.prepare('PRAGMA user_version').get().user_version, 6);
  assert.deepEqual(JSON.parse(migrated.prepare('SELECT payload FROM runs WHERE id=?').get(legacyId).payload), legacy); migrated.close();
  const seeded = await api(origin, '/api/suites'); assert.equal(seeded.length, 3);
  assert.equal(seeded.find(s => s.applicationId === 'writerapp').testIds.length, 5);
  assert.deepEqual((await api(origin, '/api/catalog')).tests.map(t => t.id), catalog.tests.map(t => t.id));
  await reject('/api/suites', { applicationId: 'virtual-company', name: 'Invalid', description: 'Cross-app fixture.', testIds: ['getright-save-note'] });
  await reject('/api/suites', { applicationId: 'virtual-company', name: '', description: 'Invalid', testIds: [] });
  await api(origin, '/api/applications/virtual-company/profile', { applicationId: 'virtual-company', baseUrl: `http://127.0.0.1:${company.address().port}`,
    expectedBuildVersion: runtime.version, expectedUserId: runtime.userId, expectedCompanyId: runtime.companyId, expectedRole: 'owner', isolatedDataConfirmed: true });
  browser = await chromium.launch({ headless: true }); const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/runs/${legacyId}`);
  const panel = page.getByRole('complementary', { name: 'Tested application', exact: true });
  await page.getByRole('button', { name: 'Open test page', exact: true }).click();
  const reviewTarget = panel.locator('iframe').contentFrame();
  await expect(reviewTarget.getByRole('heading', { name: 'Your working note' })).toBeVisible();
  await expect(reviewTarget.getByLabel('Title', { exact: true })).toHaveValue('');
  await panel.getByRole('button', { name: 'Close tested application panel' }).click();
  assert.deepEqual(await api(origin, `/api/runs/${legacyId}`), restored, 'Opening the page from review must not alter its recorded result or acceptance.');
  assert.equal((await api(origin, '/api/runs')).length, 1);
  await page.goto(origin); await page.getByRole('button', { name: 'Virtual Company', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Create a test company and save permissions', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Open test page', exact: true }).click();
  await expect(panel.locator('iframe')).toHaveAttribute('src', `http://127.0.0.1:${company.address().port}/test-companies/new`);
  await expect(panel.locator('iframe').contentFrame().getByRole('heading', { name: 'Synthetic test company creation' })).toBeVisible();
  await panel.getByRole('button', { name: 'Close tested application panel' }).click();
  assert.equal(mutationCount, 0); assert.equal((await api(origin, '/api/runs')).length, 1);
  runtime.version = 'changed';
  await reject('/tests/virtual-company-workflow/open', undefined, /Test page unavailable/); runtime.version = 'contract-1';
  await reject('/tests/writerapp-create-save/open', undefined, /Configure/);
  await reject('/tests/writerapp-synopsis/open', undefined, /draft/); await reject('/tests/unknown/open');
  const firstDemo = await fetch(`${origin}/tests/getright-save-note/open`, { redirect: 'manual' });
  const secondDemo = await fetch(`${origin}/tests/getright-save-note/open`, { redirect: 'manual' });
  assert.equal(firstDemo.status, 302); assert.notEqual(firstDemo.headers.get('location'), secondDemo.headers.get('location'));
  report.flows.push({ id: 'SUITE-001', name: 'Schema-4 migration and stable IDs/history; read-only entry page checks, review panel and failure recovery', status: 'verified' });

  await page.getByRole('link', { name: 'Manage suites & generate cases' }).click();
  await page.getByRole('button', { name: 'New suite', exact: true }).click();
  await page.getByLabel('Suite name', { exact: true }).fill('Email permission review');
  await page.getByLabel('Suite description', { exact: true }).fill('Owner setup and draft permission behavior.');
  await page.locator('.suite-members summary').click(); await page.getByLabel('Create a test company and save permissions').check();
  await page.getByRole('button', { name: 'Create suite', exact: true }).click(); await expect(page.getByRole('status')).toContainText('Suite saved');
  const suite = (await api(origin, '/api/suites')).find(s => s.name === 'Email permission review'); assert.equal(suite.testIds.length, 1);
  await page.getByLabel('Feature or functionality').fill('Owners can save draft-email permissions. Employees cannot change them. Reload retains the permissions.');
  await page.getByLabel('Number of test cases').fill('3');
  await page.getByRole('button', { name: 'Generate test cases', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Review generated cases' })).toBeVisible();
  assert.equal((await api(origin, '/api/catalog')).tests.length, 7, 'Proposal preview must not create cases.');
  const [proposal] = await api(origin, `/api/suites/${suite.id}/proposals`);
  await page.locator('.proposal-case').first().getByLabel('Case title', { exact: true }).fill('Owner saves draft permissions');
  await page.getByLabel('Include case 3').uncheck();
  await page.getByRole('button', { name: 'Add selected draft cases to suite' }).click(); await expect(page.getByRole('status')).toContainText('Selected cases added as drafts');
  const saved = await api(origin, `/api/suites/${suite.id}`); assert.equal(saved.testIds.length, 3);
  const draftCases = (await api(origin, '/api/catalog')).tests.filter(t => t.generationId === proposal.id);
  assert.equal(draftCases.length, 2); assert.equal(draftCases[0].title, 'Owner saves draft permissions');
  for (const test of draftCases) {
    assert.equal(test.readiness, 'draft'); assert.equal(test.adapter, null); assert.equal(test.steps[0].id, 'step-1');
    await reject('/api/runs', { testId: test.id }, /adapter/); await reject(`/tests/${test.id}/open`, undefined, /draft/);
  }
  assert.equal((await api(origin, `/api/suites/${suite.id}/proposals`))[0].cases[0].title, 'Permission case 1', 'Keep the original model proposal separate from edited case definitions.');
  assert.equal((await api(origin, `/api/suites/${suite.id}/proposals/${proposal.id}/apply`, { cases: [proposed(8)] })).testIds.length, 3, 'An apply retry must not duplicate cases.');
  await reject(`/api/suites/${suite.id}`, { revision: 1, name: suite.name, description: suite.description, testIds: suite.testIds }, /changed/);
  await page.goto(origin); await page.getByLabel('Test suite', { exact: true }).selectOption(suite.id);
  await expect(page.getByLabel('Test suite', { exact: true })).toHaveValue(suite.id);
  await expect(page.locator('#suite-filter option:checked')).toContainText(suite.name);
  await expect(page.locator('.test-card')).toHaveCount(3); assert.equal(await page.locator('.run-button:disabled').count(), 2);
  await page.screenshot({ path: path.join(data, 'suite-control-room-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 }); assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: path.join(data, 'suite-control-room-mobile.png'), fullPage: true });
  await page.goto(`${origin}/suites`); await page.getByRole('button', { name: /Email permission review/ }).click();
  await page.getByText('Previous proposals', { exact: true }).click(); await page.locator('.proposal-history').first().click();
  await expect(page.locator('.proposal-case')).toHaveCount(2);
  await expect(page.locator('.proposal-case').first().getByLabel('Case title', { exact: true })).toHaveValue('Owner saves draft permissions');
  await expect(page.getByRole('button', { name: 'Add selected draft cases to suite' })).toBeDisabled();
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: path.join(data, 'proposal-review-mobile.png'), fullPage: true });
  report.flows.push({ id: 'SUITE-002', name: 'Create suite, generate, preview, edit/select, save drafts, forbid execution and retain original proposal', status: 'verified', suiteId: suite.id, proposalId: proposal.id });

  const before = (await api(origin, `/api/suites/${suite.id}/proposals`)).length;
  for (const failure of ['401', '429', '503', 'refusal', 'incomplete', 'wrong-count', 'unsafe-field', 'null-steps', 'blank-title', 'timeout']) {
    mode = failure; await reject(`/api/suites/${suite.id}/generate`, { feature: 'Synthetic permission flow.', count: 2 });
    assert.equal((await api(origin, `/api/suites/${suite.id}/proposals`)).length, before, `${failure} must not save a proposal`);
  }
  mode = 'cancel';
  await page.getByLabel('Feature or functionality').fill('Cancel this synthetic generation before completion.');
  await page.getByRole('button', { name: 'Generate test cases', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel generation', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Generation cancelled');
  assert.equal((await api(origin, `/api/suites/${suite.id}/proposals`)).length, before);
  mode = 'hold';
  const first = api(origin, `/api/suites/${suite.id}/generate`, { feature: 'Synthetic permission flow.', count: 1 });
  while (!release) await delay(10);
  await reject(`/api/suites/${suite.id}/generate`, { feature: 'Another feature.', count: 1 }, /already in progress/);
  release(); mode = 'success'; await first;
  const crossSuite = seeded.find(s => s.applicationId === 'writerapp');
  await reject(`/api/suites/${crossSuite.id}/proposals/${proposal.id}/apply`, { cases: [proposed(0)] });
  assert.equal((await api(origin, '/api/catalog')).tests.length, 9);
  assert.deepEqual(await api(origin, `/api/runs/${legacyId}`), restored);
  await dashboard.stop(); await dashboard.start();
  assert.deepEqual((await api(origin, `/api/suites/${suite.id}`)).testIds, saved.testIds);
  assert.deepEqual((await api(origin, '/api/catalog')).tests.filter(t => t.generationId === proposal.id).map(t => t.id), draftCases.map(t => t.id));
  noKey = await dashboardHost(path.join(data, 'no-key'));
  assert.equal((await api(noKey.origin, '/api/generation/status')).configured, false);
  const missing = await fetch(`${noKey.origin}/api/suites/virtual-company-suite/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ feature: 'Synthetic feature', count: 2 }) });
  assert.equal(missing.status, 400); assert((await missing.text()).includes('OPENAI_API_KEY'));
  assert.deepEqual(errors, []);
  for (const issue of report.issues) issue.status = 'verified';
  report.flows.push({ id: 'SUITE-003', name: 'Missing key, provider failure/refusal/truncation/invalid output/timeout, concurrent requests, idempotency and restart persistence', status: 'verified' });
  console.log(`PASS: suites, OpenAI HTTP contract, editable draft proposals, migration, open-page flow, mobile, failures and restart. Evidence: ${data}`);
} finally {
  release?.(); await browser?.close(); await noKey?.stop(); await dashboard.stop();
  await new Promise(resolve => provider.close(resolve)); await new Promise(resolve => company.close(resolve));
  await writeFile(path.join(data, 'suites-report.json'), JSON.stringify(report, null, 2));
}
