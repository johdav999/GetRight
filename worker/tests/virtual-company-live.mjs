// Opt-in real Virtual Company UI/API validation. --cycle also invokes real Codex.
// Production SQL Server, external providers and human acceptance are out of scope.
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { chromium, expect } from '@playwright/test';
import { repositoryRoot, api } from '../src/settings.mjs';
import { runCommand, boundedLog } from '../src/processes.mjs';
import { buildVersion } from '../src/writerapp-host.mjs';
import { buildVirtualCompany, launchVirtualCompany } from '../src/virtual-company-host.mjs';
import { jobConfiguration, executeJob } from '../src/jobs.mjs';
import { executeRun } from '../src/runner.mjs';
import { dashboardHost } from './dashboard-host.mjs';

const cycle = process.argv.includes('--cycle');
const dataPath = path.join(repositoryRoot, '.local', `vc-live-${Date.now()}`); await mkdir(dataPath, { recursive: true });
const configuration = { dataPath, headless: true, jobOptions: { buildTimeoutMs: 600000 } };
const options = await jobConfiguration(configuration, 'virtual-company');
const hooks = path.join(dataPath, 'empty-hooks'); await mkdir(hooks);
const git = (cwd, args) => runCommand('git', ['-c', 'core.longpaths=true', '-c', `core.hooksPath=${hooks}`, '-C', cwd, ...args]);
const baseCommit = (await git(options.repositoryPath, ['rev-parse', 'HEAD'])).output.trim();
let build;
if (process.env.GETRIGHT_VC_REUSE_BUILD) {
  build = JSON.parse(await readFile(process.env.GETRIGHT_VC_REUSE_BUILD, 'utf8'));
  assert.equal((await git(build.worktree, ['rev-parse', 'HEAD'])).output.trim(), baseCommit);
  build.jobRoot = path.join(dataPath, 'baseline');
} else {
  const id = randomUUID().replaceAll('-', ''); const tree = path.join(options.worktreeRoot, `vc-${id.slice(0, 8)}`); await mkdir(options.worktreeRoot, { recursive: true });
  await git(options.repositoryPath, ['worktree', 'add', '--no-checkout', '--detach', tree, baseCommit]);
  await git(tree, ['sparse-checkout', 'set', '--no-cone', '/*', '!/*/', '/src/', '/tests/', '/docs/', '/.design-addin/', '/.agents/', '!/src/VirtualCompany.Api/App_Data/']);
  await git(tree, ['checkout', 'HEAD']);
  build = await buildVirtualCompany({ worktree: tree, jobRoot: path.join(dataPath, 'baseline'), version: buildVersion(id),
    signal: AbortSignal.timeout(600000), log: boundedLog(path.join(dataPath, 'baseline-build.log')) });
}
assert.equal((await git(build.worktree, ['status', '--porcelain'])).output.trim(), '', 'Baseline source must be clean.');
const dashboard = await dashboardHost(dataPath); configuration.dashboardUrl = dashboard.origin;
let host, browser, timer; const report = { baseCommit, scope: 'Real Virtual Company UI and API services with disposable in-memory SQLite, synthetic users and no external actions.' };
try {
  host = await launchVirtualCompany({ build, resultCommit: baseCommit, signal: AbortSignal.timeout(1800000), log: boundedLog(path.join(dataPath, 'baseline-launch.log')) });
  await api(dashboard.origin, '/api/applications/virtual-company/profile', host.target);
  const original = await api(dashboard.origin, '/api/runs', { testId: 'virtual-company-workflow' });
  report.original = await executeRun(await api(dashboard.origin, '/api/worker/claim', {}), configuration);
  await writeFile(path.join(dataPath, 'cycle-report.json'), JSON.stringify(report, null, 2));
  assert.equal(report.original.status, 'passed', report.original.error);
  assert.equal(report.original.acceptance, 'pending');
  browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
  await page.goto(`${host.target.baseUrl}/settings/test-company?companyId=${report.original.identity.companyId}`);
  await expect(page.locator('#test-name')).toBeEnabled();
  await expect(page.locator('#test-recipients')).toHaveValue(`${report.original.fixtureId}@example.invalid`);
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2), 'Virtual Company mobile workflow overflow');
  await page.screenshot({ path: path.join(dataPath, 'virtual-company-mobile.png'), fullPage: true });
  console.log(`PASS: actual Virtual Company creation, draft permissions, reload persistence, employee read/write denial and reference-company isolation. Evidence: ${dataPath}`);
  if (cycle) {
    const expected = 'Create an empty test company, then populate it with fictional data when you are ready. Your existing companies are preserved.';
    const finding = { id: 'VC-UAT-001', severity: 'P3', type: 'clarity enhancement', flow: original.testId,
      observed: 'The creation description says a new workspace has fictional data, but creation produces an empty company and population is a separate action.',
      expected, evidence: `evidence/${original.id}/workflow.png`, regression: 'Creation, draft permissions and reopening still pass; the creation page displays the revised English description.', status: 'open' };
    report.finding = finding;
    const feedback = await api(dashboard.origin, `/api/runs/${original.id}/feedback`, { stepId: 'workflow', comment: finding.observed,
      requestedOutcome: `Clarify the existing English TestCreateDescription resource in src/VirtualCompany.Web/Localization/Shared/CommonResources.resx to read exactly: ${expected} This is a copy-only correction to the existing creation form; preserve layout, permissions, APIs, localization keys and all workflows. Follow the repository instructions and polish-uat-loop skill. Do not redesign the UI or change the Swedish translation as part of this English copy correction.` });
    const draft = await api(dashboard.origin, '/api/jobs', { runId: original.id, feedbackId: feedback.id }); assert.equal(draft.startBlocker, null);
    await api(dashboard.origin, `/api/jobs/${draft.id}/start`, { revision: draft.revision });
    let cursor = 0, busy = false;
    timer = setInterval(async () => { if (busy) return; busy = true;
      try { for (const event of await api(dashboard.origin, `/api/jobs/${draft.id}/events?after=${cursor}`)) { cursor = event.sequence; console.log(`${event.stage}: ${event.message.slice(0, 150)}`); } }
      catch { } finally { busy = false; }
    }, 3000);
    report.job = await executeJob(await api(dashboard.origin, '/api/worker/jobs/claim', {}), configuration);
    await writeFile(path.join(dataPath, 'cycle-report.json'), JSON.stringify(report, null, 2));
    assert.equal(report.job.status, 'awaiting-review', report.job.error); assert(report.job.threadId);
    report.rerun = await api(dashboard.origin, `/api/runs/${report.job.rerunId}`);
    assert.equal(report.rerun.status, 'passed'); assert.equal(report.rerun.acceptance, 'pending');
    assert.equal(report.rerun.parentRunId, original.id); assert.equal(report.rerun.target.sourceCommit, report.job.resultCommit);
    const changed = await readFile(path.join(report.job.worktreePath, 'src/VirtualCompany.Web/Localization/Shared/CommonResources.resx'), 'utf8'); assert(changed.includes(expected));
    assert.equal((await git(options.repositoryPath, ['rev-parse', 'HEAD'])).output.trim(), baseCommit);
    // Reopen the changed host with fresh data for a visible copy acceptance check.
    const changedBuild = await buildVirtualCompany({ worktree: report.job.worktreePath, jobRoot: path.join(dataPath, 'copy-check'), version: report.job.buildVersion,
      signal: AbortSignal.timeout(600000), log: boundedLog(path.join(dataPath, 'copy-build.log')) });
    const changedHost = await launchVirtualCompany({ build: changedBuild, resultCommit: report.job.resultCommit, signal: AbortSignal.timeout(180000), log: boundedLog(path.join(dataPath, 'copy-launch.log')) });
    try { await page.setViewportSize({ width: 1440, height: 1000 }); await page.goto(`${changedHost.target.baseUrl}/test-companies/new`);
      await expect(page.locator('#test-name')).toBeEnabled();
      await expect(page.locator('.test-create p')).toHaveText(expected); await page.screenshot({ path: path.join(dataPath, 'copy-after.png'), fullPage: true });
    } finally { await changedHost.stop(); }
    finding.status = 'verified'; console.log(`PASS: real Codex → local result commit → changed Virtual Company build → linked passing rerun, acceptance pending. Job: ${report.job.id}`);
  }
} finally {
  clearInterval(timer); await writeFile(path.join(dataPath, 'cycle-report.json'), JSON.stringify(report, null, 2));
  await browser?.close(); await host?.stop(); await dashboard.stop();
}
