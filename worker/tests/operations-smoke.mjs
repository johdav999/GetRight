// Real dashboard/browser/process/Git checks. Target-app changes use explicit
// synthetic adapters; this suite never invokes Codex or production applications.
import assert from 'node:assert/strict';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, access, unlink } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { chromium, expect } from '@playwright/test';
import { repositoryRoot, api } from '../src/settings.mjs';
import { executeRun, workerClaim } from '../src/run-execution.mjs';
import { executeJob } from '../src/jobs.mjs';
import { executeCleanup } from '../src/cleanup.mjs';
import { runCommand } from '../src/processes.mjs';
import { dashboardHost } from './dashboard-host.mjs';
import { createWriterAppContractHost } from './writerapp-contract-host.mjs';

const dataPath = path.join(repositoryRoot, '.local', `operations-${Date.now()}`); await mkdir(dataPath, { recursive: true });
const legacyTest = JSON.parse(await readFile(path.join(repositoryRoot, 'config/catalog.json'), 'utf8')).tests[0];
const legacy = { id: 'a'.repeat(32), testId: legacyTest.id, applicationId: 'getright', status: 'failed', acceptance: 'accepted',
 createdAt: new Date().toISOString(), completedAt: new Date().toISOString(), fixtureId: `uat-${'a'.repeat(32)}`, steps: [], testSnapshot: legacyTest };
const schema3 = new DatabaseSync(path.join(dataPath, 'getright.db'));
schema3.exec('CREATE TABLE runs(id TEXT PRIMARY KEY,payload TEXT NOT NULL,lease TEXT); CREATE TABLE feedback(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id),payload TEXT NOT NULL); CREATE TABLE application_profiles(id TEXT PRIMARY KEY,payload TEXT NOT NULL); CREATE TABLE improvement_jobs(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id),feedback_id TEXT NOT NULL REFERENCES feedback(id),payload TEXT NOT NULL,lease TEXT,lease_expires TEXT); CREATE TABLE job_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,job_id TEXT NOT NULL REFERENCES improvement_jobs(id),created_at TEXT NOT NULL,stage TEXT NOT NULL,message TEXT NOT NULL); PRAGMA user_version=3;');
schema3.prepare('INSERT INTO runs(id,payload) VALUES(?,?)').run(legacy.id, JSON.stringify(legacy)); schema3.close();
const dashboard = await dashboardHost(dataPath); const origin = dashboard.origin;
const configuration = { dataPath, dashboardUrl: origin, headless: true };
const database = () => new DatabaseSync(path.join(dataPath, 'getright.db'));
const patch = (table, id, change) => { const db = database(); const row = JSON.parse(db.prepare(`SELECT payload FROM ${table} WHERE id=?`).get(id).payload);
  db.prepare(`UPDATE ${table} SET payload=? WHERE id=?`).run(JSON.stringify({ ...row, ...change }), id); db.close(); };
const rejected = async (route, body) => {
  const response = await fetch(`${origin}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(response.status, 400, `${route}: ${await response.text()}`);
};
const queue = () => api(origin, '/api/runs', { testId: 'getright-save-note' });
const claim = () => api(origin, '/api/worker/claim', workerClaim);
const runDemo = async () => { await queue(); const result = await executeRun(await claim(), configuration); assert.equal(result.status, 'passed', result.error); return result; };
const age = run => patch('runs', run.id, { completedAt: new Date(Date.now() - 2 * 86400000).toISOString() });
const cleanup = async candidate => {
  await api(origin, '/api/maintenance/tasks', { ...candidate, retentionDays: 1 });
  return executeCleanup(await api(origin, '/api/worker/cleanup/claim', {}), configuration);
};
let browser, proxy, baseline, changedHost;
const sockets = new Set();
const report = { scope: 'Milestone 4 local operational acceptance', flows: [], issues: [{ id: 'OPS-UAT-001', severity: 'P2', flow: 'History pagination', observed: 'Prerendered pagination buttons accepted clicks before Blazor hydration, leaving the page unchanged.', expected: 'Controls wait for interactivity and Next page displays the next result page.', evidence: 'history-desktop.png', status: 'open' }] };
try {
  const db = database(); assert.equal(db.prepare('PRAGMA user_version').get().user_version, 8); db.close();
  assert.equal((await api(origin, `/api/runs/${legacy.id}`)).acceptance, 'accepted');
  assert.equal((await api(origin, `/api/runs/${legacy.id}/reviews`)).length, 0);
  const cancelled = await queue(); await api(origin, `/api/runs/${cancelled.id}/cancel`, {});
  assert.equal((await api(origin, `/api/runs/${cancelled.id}`)).status, 'cancelled'); assert.equal(await claim(), null);
  const queued = await queue(); const leased = await claim();
  await rejected(`/api/runs/${queued.id}/heartbeat`, { lease: 'wrong' });
  await api(origin, `/api/runs/${queued.id}/heartbeat`, { lease: leased.lease });
  await api(origin, `/api/runs/${queued.id}/cancel`, {});
  assert.equal((await api(origin, `/api/runs/${queued.id}/heartbeat`, { lease: leased.lease })).cancelRequested, true);
  assert.equal((await api(origin, `/api/runs/${queued.id}/complete`, { lease: leased.lease, status: 'passed' })).status, 'cancelled');
  await rejected(`/api/runs/${queued.id}/complete`, { lease: leased.lease, status: 'failed' });

  const first = await runDemo(), second = await runDemo();
  await api(origin, `/api/runs/${first.id}/review`, { acceptance: 'accepted' });
  const feedback = await api(origin, `/api/runs/${first.id}/feedback`, { stepId: 'save', comment: 'Operational audit fixture.', requestedOutcome: 'Retain the original decision trail.' });
  let audit = await api(origin, `/api/runs/${first.id}/reviews`); assert.equal(audit.length, 2);
  assert.equal(audit[1].previous, 'accepted'); assert.equal(audit[1].current, 'improvements-requested'); assert.equal(audit[1].feedbackId, feedback.id);
  assert.equal((await api(origin, `/api/runs/${second.id}`)).acceptance, 'pending');
  await api(origin, `/api/runs/${first.id}/review`, { acceptance: 'accepted' });
  assert.equal((await api(origin, `/api/runs/${first.id}/reviews?after=${audit[1].sequence}`)).length, 1);
  for (let i = 0; i < 60; i++) await api(origin, `/api/runs/${first.id}/review`, { acceptance: i % 2 ? 'accepted' : 'pending' });
  assert.equal((await api(origin, `/api/runs/${first.id}/reviews`)).length, 50);
  report.flows.push({ id: 'OPS-001', name: 'Repeated runs, cancellation and independent review audit', status: 'verified', first: first.id, second: second.id });

  // Stall only the visible fixture. All lease and result traffic still reaches
  // the real dashboard, so browser cancellation is observable at a real socket.
  let waiting;
  proxy = http.createServer((req, res) => {
    if (req.url.startsWith('/uat-fixture.html')) { waiting?.(); return; }
    const upstream = http.request(new URL(req.url, origin), { method: req.method, headers: { ...req.headers, host: new URL(origin).host } }, response => { res.writeHead(response.statusCode, response.headers); response.pipe(res); });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); }); req.pipe(upstream);
  });
  proxy.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  const stalledConfig = { ...configuration, dashboardUrl: `http://127.0.0.1:${proxy.address().port}` };
  async function blockedRun(extra = {}) {
    const run = await queue(), lease = await claim();
    let started; const visible = new Promise(resolve => { started = resolve; }); waiting = started;
    const running = executeRun(lease, { ...stalledConfig, ...extra });
    await Promise.race([visible, delay(10000).then(() => { throw new Error('The browser did not reach the stalled fixture.'); })]);
    return { run, lease, running };
  }
  let blocked = await blockedRun(); await api(origin, `/api/runs/${blocked.run.id}/cancel`, {});
  assert.equal((await blocked.running).status, 'cancelled');
  const controller = new AbortController(); blocked = await blockedRun({ signal: controller.signal }); controller.abort(new Error('Worker shutdown fixture.'));
  assert.equal((await blocked.running).status, 'interrupted');
  blocked = await blockedRun({ runTimeoutMs: 1500 }); assert.equal((await blocked.running).status, 'failed');
  blocked = await blockedRun();
  const expiry = database(); expiry.prepare('UPDATE runs SET lease_expires=? WHERE id=?').run('2000-01-01T00:00:00+00:00', blocked.run.id); expiry.close();
  assert.equal((await api(origin, `/api/runs/${blocked.run.id}`)).status, 'interrupted');
  assert.equal((await blocked.running).status, 'interrupted');
  await rejected(`/api/runs/${blocked.run.id}/complete`, { lease: blocked.lease.lease, status: 'failed' });
  blocked = await blockedRun(); await dashboard.stop(); await dashboard.start();
  assert.equal((await blocked.running).status, 'interrupted');
  assert.equal((await api(origin, `/api/runs/${first.id}`)).acceptance, 'accepted');
  assert.equal((await api(origin, `/api/runs/${first.id}/reviews`)).length, 50);
  report.flows.push({ id: 'OPS-002', name: 'Browser cancellation, bounded timeout, shutdown, expired lease and dashboard restart', status: 'verified' });

  // Exercise pagination past the legacy recent-100 endpoint without making
  // placeholder records masquerade as browser acceptance.
  const many = database(); const insert = many.prepare('INSERT INTO runs(id,payload) VALUES(?,?)');
  for (let i = 0; i < 105; i++) { const id = randomUUID().replaceAll('-', ''); insert.run(id, JSON.stringify({ ...first, id, fixtureId: `uat-${id}`, status: 'failed', acceptance: 'pending', steps: [], trace: null, error: 'Synthetic pagination fixture' })); } many.close();
  const page1 = await api(origin, '/api/history?pageSize=20');
  const betweenPages = await queue(); await api(origin, `/api/runs/${betweenPages.id}/cancel`, {});
  const page2 = await api(origin, `/api/history?page=2&pageSize=20&snapshot=${page1.snapshot}`);
  assert.equal(page1.total, page2.total, 'New runs must not shift the selected history snapshot.');
  assert(page1.total > 100); assert.equal(page1.items.length, 20); assert.equal(page2.items.length, 20);
  assert(!page2.items.some(run => page1.items.some(other => other.id === run.id)));
  assert.equal((await api(origin, '/api/runs')).length, 100);
  assert.equal((await api(origin, `/api/runs/${first.id}`)).id, first.id);
  const badPage = await fetch(`${origin}/api/history?pageSize=101`); assert.equal(badPage.status, 400);
  browser = await chromium.launch({ headless: true }); const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/history`); await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(page.getByText(/runs · page 2/)).toBeVisible(); report.issues[0].status = 'verified';
  await page.screenshot({ path: path.join(dataPath, 'history-desktop.png'), fullPage: true });
  await page.goto(`${origin}/compare?before=${first.id}&after=${second.id}`);
  await expect(page.getByRole('heading', { name: 'Compare runs', exact: true })).toBeVisible();
  assert.equal(await page.locator('.compare-images img').count(), 8);
  await page.screenshot({ path: path.join(dataPath, 'comparison-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 }); assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: path.join(dataPath, 'comparison-mobile.png'), fullPage: true });
  await page.goto(`${origin}/runs/${first.id}`); await expect(page.getByRole('heading', { name: 'Review history', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Load more review events' }).click(); await expect(page.locator('.review-event')).toHaveCount(63);
  report.flows.push({ id: 'OPS-003', name: 'History beyond 100 runs, comparison and mobile review', status: 'verified' });

  age(first);
  const protectedJob = await api(origin, '/api/jobs', { runId: first.id, feedbackId: feedback.id });
  assert(!(await api(origin, '/api/maintenance/preview?days=1')).some(c => c.resourceId === first.id));
  await api(origin, `/api/jobs/${protectedJob.id}/cancel`, {});
  await page.goto(`${origin}/maintenance`); await page.getByLabel('Keep evidence for at least this many days').fill('1');
  await page.getByRole('button', { name: 'Preview cleanup', exact: true }).click();
  await page.getByRole('button', { name: 'Select for removal', exact: true }).first().click();
  await page.getByRole('button', { name: 'Queue removal', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Removal queued');
  await page.getByRole('button', { name: 'Cancel queued removal', exact: true }).click();
  assert.equal(await api(origin, '/api/worker/cleanup/claim', {}), null);
  assert.equal((await api(origin, `/api/runs/${first.id}`)).evidenceRetiredAt, null);
  const freshPreview = (await api(origin, '/api/maintenance/preview?days=1')).find(c => c.resourceId === first.id);
  await api(origin, '/api/maintenance/tasks', { ...freshPreview, retentionDays: 1 });
  await rejected(`/api/runs/${first.id}/review`, { acceptance: 'pending' });
  const removal = await api(origin, '/api/worker/cleanup/claim', {}); assert.equal(removal.task.resourceId, first.id);
  assert.equal((await executeCleanup(removal, configuration)).status, 'completed');
  assert.equal((await fetch(`${origin}/api/evidence/${first.steps[0].screenshot}`)).status, 404);
  assert.equal((await api(origin, `/api/runs/${first.id}`)).status, 'passed');
  assert.equal((await api(origin, `/api/runs/${first.id}/feedback`)).length, 1);
  assert.equal((await api(origin, `/api/runs/${first.id}/reviews`)).length, 50);
  assert.equal((await fetch(`${origin}/api/evidence/${second.steps[0].screenshot}`)).status, 200);
  await rejected('/api/jobs', { runId: first.id, feedbackId: feedback.id });

  // Unknown files must block deletion before even a registered screenshot goes.
  await api(origin, `/api/runs/${second.id}/review`, { acceptance: 'accepted' }); age(second);
  const sentinel = path.join(dataPath, 'evidence', second.id, 'keep-me.txt'); await writeFile(sentinel, 'User file');
  let candidate = (await api(origin, '/api/maintenance/preview?days=1')).find(c => c.resourceId === second.id);
  assert.equal((await cleanup(candidate)).status, 'failed');
  await access(path.join(dataPath, 'evidence', second.steps[0].screenshot)); assert.equal(await readFile(sentinel, 'utf8'), 'User file');
  await unlink(sentinel);
  candidate = (await api(origin, '/api/maintenance/preview?days=1')).find(c => c.resourceId === second.id);
  assert.equal((await cleanup(candidate)).status, 'completed');
  const third = await runDemo(); await api(origin, `/api/runs/${third.id}/review`, { acceptance: 'accepted' }); age(third);
  candidate = (await api(origin, '/api/maintenance/preview?days=1')).find(c => c.resourceId === third.id);
  await api(origin, '/api/maintenance/tasks', { ...candidate, retentionDays: 1 });
  let abandoned = await api(origin, '/api/worker/cleanup/claim', {});
  const cleanupExpiry = database(); cleanupExpiry.prepare('UPDATE cleanup_tasks SET lease_expires=? WHERE id=?').run('2000-01-01T00:00:00+00:00', abandoned.task.id); cleanupExpiry.close();
  assert.equal((await api(origin, '/api/maintenance/tasks')).find(t => t.id === abandoned.task.id).status, 'interrupted');
  await rejected(`/api/maintenance/tasks/${abandoned.task.id}/finish`, { lease: abandoned.lease, status: 'completed' });
  candidate = (await api(origin, '/api/maintenance/preview?days=1')).find(c => c.resourceId === third.id);
  await api(origin, '/api/maintenance/tasks', { ...candidate, retentionDays: 1 }); abandoned = await api(origin, '/api/worker/cleanup/claim', {});
  await unlink(path.join(dataPath, 'evidence', third.steps[0].screenshot)); // Simulate a crash part-way through this explicitly selected disposable fixture.
  await dashboard.stop(); await dashboard.start();
  assert.equal((await api(origin, '/api/maintenance/tasks')).find(t => t.id === abandoned.task.id).status, 'interrupted');
  assert((await api(origin, `/api/runs/${third.id}`)).evidenceRetiredAt);
  candidate = (await api(origin, '/api/maintenance/preview?days=1')).find(c => c.resourceId === third.id);
  assert.equal((await cleanup(candidate)).status, 'completed');
  assert.equal((await api(origin, `/api/runs/${third.id}`)).status, 'passed');
  assert.equal((await api(origin, `/api/runs/${third.id}/reviews`)).length, 1);
  report.flows.push({ id: 'OPS-004', name: 'Explicit retention, active-job protection, unknown-file refusal, retry and retained audit', status: 'verified' });

  // A synthetic application change exercises real Git worktree removal while
  // leaving the original repository and result branch intact.
  const source = path.join(dataPath, 'source'); await mkdir(source);
  const git = args => runCommand('git', ['-C', source, ...args]);
  await git(['init', '--initial-branch=main']); await git(['config', 'user.name', 'Getright Operations']); await git(['config', 'user.email', 'operations@example.invalid']);
  await writeFile(path.join(source, 'BlazorApp.csproj'), '<Project />'); await writeFile(path.join(source, 'app.txt'), 'base');
  await git(['add', '.']); await git(['commit', '-m', 'Synthetic operations baseline']);
  const baseCommit = (await git(['rev-parse', 'HEAD'])).output.trim();
  baseline = await createWriterAppContractHost();
  const profile = { applicationId: 'writerapp', baseUrl: baseline.origin, expectedBuildVersion: baseline.state.version, expectedUserId: baseline.state.userId, isolatedDataConfirmed: true, sourceCommit: baseCommit, sourceWasDirty: false };
  await api(origin, '/api/applications/writerapp/profile', profile);
  const original = await api(origin, '/api/runs', { testId: 'writerapp-create-save' });
  assert.equal((await executeRun(await claim(), configuration)).status, 'passed');
  const change = await api(origin, `/api/runs/${original.id}/feedback`, { stepId: 'library', comment: 'Synthetic cleanup lifecycle.', requestedOutcome: 'Retain the result commit after worktree removal.' });
  const draft = await api(origin, '/api/jobs', { runId: original.id, feedbackId: change.id });
  await api(origin, `/api/jobs/${draft.id}/start`, { revision: draft.revision });
  const jobConfiguration = { ...configuration, jobOptions: { repositoryPath: source, worktreeRoot: path.join(repositoryRoot, 'worktrees') } };
  const job = await executeJob(await api(origin, '/api/worker/jobs/claim', workerClaim), jobConfiguration, {
    implement: async ({ worktree, report }) => { await writeFile(path.join(worktree, 'app.txt'), 'changed'); await report('Synthetic source change.', { threadId: 'operations-contract' }); return { summary: 'Synthetic operations change.' }; },
    build: async input => {
      const artifact = path.join(input.jobRoot, 'compiled.txt');
      await writeFile(artifact, input.version);
      return { ...input, artifactRoots: [artifact] };
    },
    launch: async ({ build, resultCommit }) => { changedHost = await createWriterAppContractHost(); changedHost.state.version = build.version; changedHost.state.userId = profile.expectedUserId;
      return { target: { ...profile, baseUrl: changedHost.origin, expectedBuildVersion: build.version, sourceCommit: resultCommit }, stop: async () => { await changedHost.close(); changedHost = null; } }; },
  });
  assert.equal(job.status, 'awaiting-review', job.error); patch('improvement_jobs', job.id, { updatedAt: new Date(Date.now() - 180000).toISOString() });
  assert(!(await api(origin, '/api/maintenance/preview?days=1')).some(c => c.resourceId === job.id));
  await api(origin, `/api/runs/${job.rerunId}/review`, { acceptance: 'accepted' });
  let tree = (await api(origin, '/api/maintenance/preview?days=1')).find(c => c.resourceId === job.id); assert(tree);
  await writeFile(path.join(job.worktreePath, 'app.txt'), 'keep uncommitted work');
  await api(origin, '/api/maintenance/tasks', tree);
  assert.equal((await executeCleanup(await api(origin, '/api/worker/cleanup/claim', {}), jobConfiguration)).status, 'failed');
  await access(job.worktreePath); await writeFile(path.join(job.worktreePath, 'app.txt'), 'changed');
  tree = (await api(origin, '/api/maintenance/preview?days=1')).find(c => c.resourceId === job.id);
  await api(origin, '/api/maintenance/tasks', tree);
  assert.equal((await executeCleanup(await api(origin, '/api/worker/cleanup/claim', {}), jobConfiguration)).status, 'completed');
  await assert.rejects(access(job.worktreePath));
  assert.equal((await git(['rev-parse', 'HEAD'])).output.trim(), baseCommit);
  assert.equal((await git(['rev-parse', `getright/job-${job.id}`])).output.trim(), job.resultCommit);
  assert.equal((await fetch(`${origin}/api/jobs/${job.id}/artifacts/diff.patch`)).status, 200);
  assert((await api(origin, `/api/jobs/${job.id}`)).worktreeRemovedAt);
  report.flows.push({ id: 'OPS-005', name: 'Reviewed worktree cleanup, dirty refusal, retained branch/commit/logs', status: 'verified', jobId: job.id });
  const batches = database(); const batchInsert = batches.prepare('INSERT INTO runs(id,payload) VALUES(?,?)');
  for (let i = 0; i < 205; i++) { const id = randomUUID().replaceAll('-', ''); batchInsert.run(id, JSON.stringify({ ...legacy, id, fixtureId: `uat-${id}` })); } batches.close();
  assert.equal((await api(origin, '/api/maintenance/preview-page?days=1')).hasMore, true);
  await page.goto(`${origin}/maintenance`); await page.getByRole('button', { name: 'Preview cleanup', exact: true }).click();
  await page.getByRole('button', { name: 'Next batch', exact: true }).click(); await expect(page.getByText('Preview batch 2', { exact: true })).toBeVisible();
  await page.goto(`${origin}/maintenance`); await page.screenshot({ path: path.join(dataPath, 'maintenance-mobile.png'), fullPage: true });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); assert.deepEqual(errors, []);
  console.log(`PASS: run supervision/cancellation/recovery, review audit, pagination/comparison, explicit evidence retention and clean worktree removal. Evidence: ${dataPath}`);
} finally {
  await writeFile(path.join(dataPath, 'operations-report.json'), JSON.stringify(report, null, 2));
  await browser?.close(); await baseline?.close(); await changedHost?.close();
  for (const socket of sockets) socket.destroy(); if (proxy) await new Promise(resolve => proxy.close(resolve)); await dashboard.stop();
}
