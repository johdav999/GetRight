// Opt-in milestone-2 acceptance: actual Codex SDK, WriterApp builds and browsers.
// Creates reviewable local worktrees/commits only; never merges or publishes them.
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { repositoryRoot, api } from '../src/settings.mjs';
import { runCommand, boundedLog } from '../src/processes.mjs';
import { buildWriterApp, launchWriterApp, buildVersion } from '../src/writerapp-host.mjs';
import { executeRun, workerClaim } from '../src/run-execution.mjs';
import { executeJob, jobConfiguration } from '../src/jobs.mjs';
import { dashboardHost } from './dashboard-host.mjs';

const dataPath = path.join(repositoryRoot, '.local', `cycle-live-${Date.now()}`); await mkdir(dataPath, { recursive: true });
const configuration = { dataPath, headless: true };
const options = await jobConfiguration(configuration);
const hooks = path.join(dataPath, 'empty-hooks'); await mkdir(hooks);
const git = (cwd, args) => runCommand('git', ['-c', `core.hooksPath=${hooks}`, '-C', cwd, ...args]);
const baseCommit = (await git(options.repositoryPath, ['rev-parse', 'HEAD'])).output.trim();
const baselineTree = path.join(dataPath, 'baseline-source');
await git(options.repositoryPath, ['worktree', 'add', '--detach', baselineTree, baseCommit]);
const dashboard = await dashboardHost(dataPath); configuration.dashboardUrl = dashboard.origin;
const baselineId = randomUUID().replaceAll('-', '');
let baselineHost, progressTimer;
const expectedSubtitle = 'Create a document or open a saved draft to continue writing.';
try {
  console.log(`Building clean WriterApp baseline at ${baseCommit}.`);
  const baselineBuild = await buildWriterApp({ worktree: baselineTree, jobRoot: path.join(dataPath, 'baseline'), jobId: baselineId, version: buildVersion(baselineId), signal: AbortSignal.timeout(300000), log: boundedLog(path.join(dataPath, 'baseline-build.log')) });
  assert.equal((await git(baselineTree, ['status', '--porcelain'])).output.trim(), '');
  baselineHost = await launchWriterApp({ build: baselineBuild, resultCommit: baseCommit, signal: AbortSignal.timeout(600000), log: boundedLog(path.join(dataPath, 'baseline-launch.log')) });
  await api(dashboard.origin, '/api/applications/writerapp/profile', baselineHost.target);
  const original = await api(dashboard.origin, '/api/runs', { testId: 'writerapp-create-save' });
  const originalClaim = await api(dashboard.origin, '/api/worker/claim', workerClaim);
  const originalResult = await executeRun(originalClaim, configuration); assert.equal(originalResult.status, 'passed', originalResult.error);
  const feedback = await api(dashboard.origin, `/api/runs/${original.id}/feedback`, {
    stepId: 'library',
    comment: 'The Documents library subtitle tells me to start with a project even when I am working with standalone documents. It is confusing in this workflow.',
    requestedOutcome: `In the Documents view of WriterApp.Client/Pages/DocumentsList.razor, use the exact subtitle: ${expectedSubtitle} Keep the current project-oriented subtitle in Projects view. Preserve every creation, save and reopen behavior. This is a small copy correction; no layout or API changes are needed.`,
  });
  const draft = await api(dashboard.origin, '/api/jobs', { runId: original.id, feedbackId: feedback.id });
  assert.equal(draft.startBlocker, null);
  await api(dashboard.origin, `/api/jobs/${draft.id}/start`, { revision: draft.revision });
  const claim = await api(dashboard.origin, '/api/worker/jobs/claim', workerClaim); assert.equal(claim.job.id, draft.id);
  let cursor = 0, polling = false;
  progressTimer = setInterval(async () => {
    if (polling) return; polling = true;
    try { for (const event of await api(dashboard.origin, `/api/jobs/${draft.id}/events?after=${cursor}`)) { cursor = event.sequence; console.log(`${event.stage}: ${event.message.slice(0, 180)}`); } }
    catch { /* The worker handles lease errors; progress printing is optional. */ }
    finally { polling = false; }
  }, 2500);
  console.log(`Starting real Codex implementation job ${draft.id}.`);
  const result = await executeJob(claim, configuration);
  assert.equal(result.status, 'awaiting-review', result.error);
  const rerun = await api(dashboard.origin, `/api/runs/${result.rerunId}`);
  assert.equal(rerun.status, 'passed'); assert.equal(rerun.acceptance, 'pending');
  assert.equal(rerun.parentRunId, original.id); assert.equal(rerun.target.sourceCommit, result.resultCommit);
  assert(result.threadId, 'A real Codex thread must be retained.');
  assert.notEqual(result.resultCommit, baseCommit);
  const changedSource = await readFile(path.join(result.worktreePath, 'WriterApp.Client/Pages/DocumentsList.razor'), 'utf8');
  assert(changedSource.includes(expectedSubtitle), 'The requested copy improvement must be present in the resulting source.');
  assert.equal((await git(options.repositoryPath, ['rev-parse', 'HEAD'])).output.trim(), baseCommit, 'The original branch must remain unchanged.');
  const report = { scope: 'Actual Codex SDK implementation in an isolated WriterApp worktree; clean source baseline; actual builds and browser persistence tests. No external-auth, collaboration or human acceptance claim.', original: originalResult, job: result, rerun };
  await writeFile(path.join(dataPath, 'cycle-report.json'), JSON.stringify(report, null, 2));
  console.log(`PASS: real feedback → Codex → result commit → verified build → linked passing rerun. Human acceptance is pending.\nEvidence: ${dataPath}`);
} finally { clearInterval(progressTimer); await baselineHost?.stop(); await dashboard.stop(); }
