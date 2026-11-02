import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, expect } from '@playwright/test';
import { api, repositoryRoot } from '../src/settings.mjs';
import { executeRun } from '../src/runner.mjs';

const portProbe = createServer();
portProbe.listen(0, '127.0.0.1'); await once(portProbe, 'listening');
const port = portProbe.address().port;
await new Promise(resolve => portProbe.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const dataPath = path.join(repositoryRoot, '.local', `smoke-${Date.now()}`);
await mkdir(dataPath, { recursive: true });
const configuration = { dashboardUrl: origin, dataPath, headless: true };
const projectPath = path.join(repositoryRoot, 'src/Getright.Dashboard');
const dll = path.join(projectPath, 'bin/Release/net10.0/Getright.Dashboard.dll');
let server, browser, logs = '';

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
  await rejected(`/api/runs/${interrupted.id}/complete`, { lease: interruptedClaim.lease, status: 'failed' });
  console.log(`PASS: dashboard, queue claims, four-step browser run, evidence, feedback export, independent acceptance, mobile layouts, failure handling and restart persistence.\nLocal evidence: ${dataPath}`);
} catch (error) {
  console.error(logs.slice(-6000)); throw error;
} finally { await browser?.close(); await stop(); }
