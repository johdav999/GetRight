import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, expect } from '@playwright/test';
import { api, repositoryRoot } from '../src/settings.mjs';
import { executeRun } from '../src/runner.mjs';
import { createWriterAppContractHost } from './writerapp-contract-host.mjs';

const portProbe = createServer();
portProbe.listen(0, '127.0.0.1'); await once(portProbe, 'listening');
const port = portProbe.address().port;
await new Promise(resolve => portProbe.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const dataPath = path.join(repositoryRoot, '.local', `smoke-${Date.now()}`);
await mkdir(dataPath, { recursive: true });
// Exercise the schema-1 upgrade with a legacy record that has no target/identity.
const legacyTest = JSON.parse(await readFile(path.join(repositoryRoot, 'config/catalog.json'), 'utf8')).tests[0];
const legacyRun = { id: 'a'.repeat(32), testId: legacyTest.id, applicationId: 'getright', status: 'failed', acceptance: 'pending', createdAt: new Date().toISOString(), startedAt: null, completedAt: new Date().toISOString(), fixtureId: `uat-${'a'.repeat(32)}`, buildVersion: null, baseUrl: null, steps: [], trace: null, error: 'Legacy fixture', testSnapshot: legacyTest };
const legacyDb = new DatabaseSync(path.join(dataPath, 'getright.db'));
legacyDb.exec('CREATE TABLE runs(id TEXT PRIMARY KEY,payload TEXT NOT NULL,lease TEXT); CREATE TABLE feedback(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id),payload TEXT NOT NULL); PRAGMA user_version=1;');
legacyDb.prepare('INSERT INTO runs(id,payload) VALUES(?,?)').run(legacyRun.id, JSON.stringify(legacyRun));
legacyDb.close();
const configuration = { dashboardUrl: origin, dataPath, headless: true };
const projectPath = path.join(repositoryRoot, 'src/Getright.Dashboard');
const dll = path.join(projectPath, 'bin/Release/net10.0/Getright.Dashboard.dll');
let server, browser, writerHost, logs = '';

async function start() {
  logs = '';
  server = spawn('dotnet', [dll, '--urls', origin], {
    cwd: projectPath, windowsHide: true,
    env: { ...process.env, ASPNETCORE_ENVIRONMENT: 'Production', Getright__DataPath: dataPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', data => { logs += data; });
  server.stderr.on('data', data => { logs += data; });
  let launchError;
  server.on('error', error => { launchError = error; });
  let connectionError;
  for (let i = 0; i < 100; i++) {
    if (launchError) throw launchError;
    if (server.exitCode !== null) throw new Error(`Dashboard exited: ${logs}`);
    try { await api(origin, '/api/health'); return; } catch (error) { connectionError = error; await delay(200); }
  }
  throw new Error(`Dashboard did not start: ${connectionError?.message} ${connectionError?.cause?.message ?? ''}\n${logs}`);
}
async function stop() {
  if (server && server.exitCode === null) { const exited = once(server, 'exit'); server.kill(); await exited; }
}
async function rejected(route, body, status = 400) {
  const response = await fetch(`${origin}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(response.status, status, `${route} should reject the request`);
}

try {
  await start();
  assert.equal((await api(origin, `/api/runs/${legacyRun.id}`)).error, 'Legacy fixture');
  const catalog = await api(origin, '/api/catalog');
  assert.equal(catalog.tests.length, 7);
  assert.equal(catalog.tests.filter(t => t.applicationId === 'writerapp').length, 5);
  await rejected('/api/runs', { testId: 'writerapp-create-save' });
  const crossOrigin = await fetch(`${origin}/api/worker/claim`, { method: 'POST', headers: { Origin: 'http://untrusted.example' } });
  assert.equal(crossOrigin.status, 403);

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } });
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(origin);
  await expect(page.getByRole('heading', { name: 'Test control room', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Run UAT test' }).first()).toBeEnabled();
  assert.equal(await page.getByRole('button', { name: 'Run UAT test' }).count(), 7);
  assert.equal(await page.locator('button.run-button:disabled').count(), 6);
  await page.screenshot({ path: path.join(dataPath, 'dashboard-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: 'Run UAT test' }).first().click();
  await expect(page.getByRole('status')).toContainText('queued');
  const [run] = await api(origin, '/api/runs');
  assert.equal(run.acceptance, 'pending');
  await rejected(`/api/runs/${run.id}/review`, { acceptance: 'accepted' });
  const claims = await Promise.all([api(origin, '/api/worker/claim', {}), api(origin, '/api/worker/claim', {})]);
  assert.equal(claims.filter(Boolean).length, 1, 'a queued run must only be claimed once');
  const claim = claims.find(Boolean);
  await rejected(`/api/runs/${run.id}/complete`, { lease: 'invalid', status: 'passed' });
  await rejected(`/api/runs/${run.id}/complete`, { lease: claim.lease, status: 'passed', steps: [], buildVersion: 'fake' });
  const completed = await executeRun(claim, configuration);
  assert.equal(completed.status, 'passed', completed.error);
  assert.equal(completed.acceptance, 'pending', 'automation must never auto-accept a run');
  assert.equal(completed.steps.length, 4);
  for (const step of completed.steps) {
    const response = await fetch(`${origin}/api/evidence/${step.screenshot}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
  }
  const trace = await fetch(`${origin}/api/evidence/${completed.trace}`);
  assert.equal(trace.status, 200);
  assert((await trace.arrayBuffer()).byteLength > 0);
  assert.equal((await fetch(`${origin}/api/evidence/${run.id}/unregistered.png`)).status, 404);
  await rejected(`/api/runs/${run.id}/feedback`, { stepId: 'unknown', comment: 'Feedback', requestedOutcome: 'Outcome' });
  await page.goto(`${origin}/runs/${run.id}`);
  await expect(page.getByRole('button', { name: 'Accept this run', exact: true })).toBeEnabled();
  await page.getByLabel('Test step', { exact: true }).selectOption('save');
  await page.getByLabel('What needs improving?', { exact: true }).fill('The saved confirmation could be easier to notice.');
  await page.getByLabel('Requested outcome', { exact: true }).fill('Keep a clear successful-save confirmation visible near the save button.');
  await page.getByRole('button', { name: 'Create improvement task', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Improvement task created');
  const [feedback] = await api(origin, `/api/runs/${run.id}/feedback`);
  assert(feedback.prompt.includes(completed.buildVersion));
  assert(feedback.prompt.includes(`${run.id}/save.png`));
  assert(feedback.prompt.includes(run.fixtureId));
  assert(feedback.prompt.includes('Save the note (save)'));
  const exported = await fetch(`${origin}/api/runs/${run.id}/tasks/${feedback.id}`);
  assert.equal(await exported.text(), feedback.prompt);
  assert.equal((await api(origin, `/api/runs/${run.id}`)).acceptance, 'improvements-requested');
  await page.getByRole('button', { name: 'Accept this run', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Review saved');
  assert.equal((await api(origin, `/api/runs/${run.id}`)).acceptance, 'accepted');
  await page.screenshot({ path: path.join(dataPath, 'review-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(origin);
  await expect(page.getByRole('heading', { name: 'Test control room', exact: true })).toBeVisible();
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'mobile dashboard must not overflow');
  await page.screenshot({ path: path.join(dataPath, 'dashboard-mobile.png'), fullPage: true });
  await page.goto(`${origin}/runs/${run.id}`);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'mobile review must not overflow');
  await page.screenshot({ path: path.join(dataPath, 'review-mobile.png'), fullPage: true });
  assert.deepEqual(pageErrors, []);

  // Synthetic integration contract: this section validates Getright, not WriterApp.
  writerHost = await createWriterAppContractHost();
  const profile = { applicationId: 'writerapp', baseUrl: writerHost.origin, expectedBuildVersion: writerHost.state.version, expectedUserId: writerHost.state.userId, isolatedDataConfirmed: true };
  await rejected('/api/applications/writerapp/profile', { ...profile, baseUrl: 'http://untrusted.example' });
  await rejected('/api/applications/writerapp/profile', { ...profile, isolatedDataConfirmed: false });
  await page.goto(`${origin}/applications`);
  await page.getByLabel('Local application URL', { exact: true }).fill(profile.baseUrl);
  await page.getByLabel('Expected build version', { exact: true }).fill(profile.expectedBuildVersion);
  await page.getByLabel('Dedicated UAT account ID', { exact: true }).fill(profile.expectedUserId);
  await page.getByRole('checkbox', { name: 'This instance uses isolated UAT data' }).check();
  await page.getByRole('button', { name: 'Check connection', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Ready:');
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'mobile setup must not overflow');
  await page.screenshot({ path: path.join(dataPath, 'application-setup-mobile.png'), fullPage: true });
  assert.equal(writerHost.state.creates, 0);
  writerHost.state.versionPayload = [];
  assert.equal((await api(origin, '/api/applications/writerapp/readiness')).ready, false);
  delete writerHost.state.versionPayload;
  writerHost.state.authPayload = [];
  assert.equal((await api(origin, '/api/applications/writerapp/readiness')).ready, false);
  delete writerHost.state.authPayload;
  writerHost.state.version = 'wrong-build';
  assert.equal((await api(origin, '/api/applications/writerapp/readiness')).ready, false);
  await rejected('/api/runs', { testId: 'writerapp-create-save' });
  writerHost.state.version = profile.expectedBuildVersion;
  writerHost.state.userId = 'wrong-account';
  await rejected('/api/runs', { testId: 'writerapp-create-save' });
  writerHost.state.userId = profile.expectedUserId;
  const writerRun = await api(origin, '/api/runs', { testId: 'writerapp-create-save' });
  const writerClaim = await api(origin, '/api/worker/claim', {});
  const evidenceDirectory = path.join(dataPath, 'evidence', writerRun.id);
  await mkdir(evidenceDirectory, { recursive: true });
  for (const step of writerRun.testSnapshot.steps) await writeFile(path.join(evidenceDirectory, `${step.id}.png`), 'contract placeholder');
  await writeFile(path.join(evidenceDirectory, 'trace.zip'), 'contract placeholder');
  await rejected(`/api/runs/${writerRun.id}/complete`, {
    lease: writerClaim.lease, status: 'passed', buildVersion: 'wrong-build', baseUrl: profile.baseUrl,
    identity: { userId: profile.expectedUserId, documentId: '11111111-1111-1111-1111-111111111111', evidenceKind: 'live-application' },
    steps: writerRun.testSnapshot.steps.map(step => ({ stepId: step.id, status: 'passed', screenshot: `${writerRun.id}/${step.id}.png` })), trace: `${writerRun.id}/trace.zip`,
  });
  // Editing setup cannot retarget an already queued run.
  await api(origin, '/api/applications/writerapp/profile', { ...profile, expectedBuildVersion: 'next-build' });
  const writerResult = await executeRun(writerClaim, configuration);
  assert.equal(writerResult.id, writerRun.id);
  assert.equal(writerResult.status, 'passed', writerResult.error);
  assert.equal(writerResult.target.expectedBuildVersion, profile.expectedBuildVersion);
  assert.equal(writerResult.identity.userId, profile.expectedUserId);
  assert.equal(writerResult.acceptance, 'pending');
  assert.equal(writerHost.state.creates, 1);
  await api(origin, '/api/applications/writerapp/profile', profile);
  const wrongAccountRun = await api(origin, '/api/runs', { testId: 'writerapp-create-save' });
  const wrongAccountClaim = await api(origin, '/api/worker/claim', {});
  writerHost.state.userId = 'different-account-after-queue';
  const refused = await executeRun(wrongAccountClaim, configuration);
  assert.equal(refused.id, wrongAccountRun.id); assert.equal(refused.status, 'failed');
  assert.equal(writerHost.state.creates, 1, 'account drift after queueing must not create data');
  writerHost.state.userId = profile.expectedUserId;

  const rerun = await api(origin, '/api/runs', { testId: run.testId });
  assert.equal(rerun.acceptance, 'pending');
  const failedClaim = await api(origin, '/api/worker/claim', {});
  const failed = await api(origin, `/api/runs/${rerun.id}/complete`, { lease: failedClaim.lease, status: 'failed', steps: [], error: 'Deliberate infrastructure failure for smoke verification.' });
  assert.equal(failed.status, 'failed'); assert.equal(failed.acceptance, 'pending');
  await rejected(`/api/runs/${rerun.id}/complete`, { lease: failedClaim.lease, status: 'passed' });
  const interrupted = await api(origin, '/api/runs', { testId: run.testId });
  const interruptedClaim = await api(origin, '/api/worker/claim', {});
  assert.equal(interruptedClaim.run.id, interrupted.id);
  await browser.close(); browser = null;
  await stop(); await start();
  assert.equal((await api(origin, `/api/runs/${run.id}`)).acceptance, 'accepted', 'review must survive a restart');
  assert.equal((await api(origin, `/api/runs/${run.id}/feedback`)).length, 1, 'feedback must survive a restart');
  assert.equal((await api(origin, `/api/runs/${interrupted.id}`)).status, 'interrupted');
  assert.equal((await api(origin, '/api/applications/writerapp/profile')).expectedUserId, profile.expectedUserId);
  await rejected(`/api/runs/${interrupted.id}/complete`, { lease: interruptedClaim.lease, status: 'failed' });
  console.log(`PASS: schema-1 migration, dashboard, queue claims, demo browser run, evidence, feedback export, independent acceptance, mobile layouts, WriterApp setup and synthetic adapter contract, account/build drift rejection and restart persistence.\nLocal evidence: ${dataPath}`);
} catch (error) {
  console.error(logs.slice(-6000)); throw error;
} finally { await browser?.close(); await stop(); await writerHost?.close(); }
