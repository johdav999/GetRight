// Qualify the authored Finance drafts on a disposable dashboard and real local host.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { api, repositoryRoot } from '../src/settings.mjs';
import { boundedLog, runCommand } from '../src/processes.mjs';
import { executeRun, workerClaim } from '../src/run-execution.mjs';
import { buildVirtualCompany, launchVirtualCompany } from '../src/virtual-company-host.mjs';
import { buildVersion } from '../src/writerapp-host.mjs';
import { dashboardHost } from './dashboard-host.mjs';

const [worktreeArgument, requestedVersion] = process.argv.slice(2);
assert(worktreeArgument, 'Supply a dedicated, clean detached Virtual Company worktree.');
const worktree = await realpath(worktreeArgument);
const git = async (...args) => (await runCommand('git', ['-c', 'core.fsmonitor=false', '-C', worktree, ...args])).output.trim();
assert.equal(await git('rev-parse', '--show-prefix'), '');
assert.equal(await git('rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD', 'Use a detached worktree.');
const gitPath = await git('rev-parse', '--absolute-git-dir');
const commonGitPath = path.resolve(worktree, await git('rev-parse', '--git-common-dir'));
assert.notEqual(path.resolve(gitPath), commonGitPath, 'Use a linked Git worktree.');
async function requireCleanSource() {
  assert.equal(await git('diff', 'HEAD', '--name-only'), '', 'The source worktree has tracked changes.');
  assert.equal(await git('ls-files', '--others', '--exclude-standard'), '', 'The source worktree has untracked files.');
}
await requireCleanSource();
const sourceCommit = await git('rev-parse', 'HEAD');
const version = requestedVersion ?? buildVersion(randomUUID().replaceAll('-', ''));
assert.match(version, /^\d+\.\d+\.\d+\.\d+$/);
const dataPath = path.join(repositoryRoot, '.local', `finance-agent-live-${Date.now()}`);
await mkdir(dataPath, { recursive: true });
const dashboardOutput = path.join(dataPath, 'dashboard');
const dashboardAssembly = process.env.GETRIGHT_DASHBOARD_DLL ??
  path.join(repositoryRoot, 'src/Getright.Dashboard/bin/Release/net10.0/Getright.Dashboard.dll');
await cp(path.dirname(dashboardAssembly), dashboardOutput, { recursive: true });
const cataloguePath = path.join(dashboardOutput, 'catalog.json');
const catalogue = JSON.parse(await readFile(cataloguePath, 'utf8'));
const cases = catalogue.tests.filter(test => test.id.startsWith('virtual-company-finance-'));
assert.equal(cases.length, 6);
for (const test of cases) {
  assert.equal(test.workflow?.version, 2);
  // The qualification dashboard is private to this command. Its catalogue
  // permits exercising these definitions before normal catalogue enablement.
  test.readiness = 'setup-required';
  test.adapter = 'configured-v2';
}
await writeFile(cataloguePath, JSON.stringify(catalogue));

const report = { sourceCommit, version, runs: [] };
const reportPath = path.join(dataPath, 'finance-report.json');
console.log(`Finance verification evidence: ${dataPath}`);
let dashboard, host;
try {
  const build = await buildVirtualCompany({ worktree, jobRoot: path.join(dataPath, 'target'), version,
    signal: AbortSignal.timeout(600000), log: boundedLog(path.join(dataPath, 'target-build.log')) });
  await requireCleanSource();
  assert.equal(await git('rev-parse', 'HEAD'), sourceCommit);
  dashboard = await dashboardHost(dataPath, { dllPath: path.join(dashboardOutput, 'Getright.Dashboard.dll') });
  host = await launchVirtualCompany({ build, resultCommit: sourceCommit,
    signal: AbortSignal.timeout(900000), log: boundedLog(path.join(dataPath, 'target-launch.log')) });
  const configuration = { dashboardUrl: dashboard.origin, dataPath, headless: true, keepBrowserOpen: false };
  await api(dashboard.origin, '/api/applications/virtual-company/profile', host.target);
  for (const test of cases) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const queued = await api(dashboard.origin, '/api/runs', { testId: test.id });
      const claim = await api(dashboard.origin, '/api/worker/claim', workerClaim);
      assert.equal(claim.run.id, queued.id);
      await executeRun(claim, configuration);
      const run = await api(dashboard.origin, `/api/runs/${queued.id}`);
      assert.equal(run.acceptance, 'pending');
      assert.equal(run.target.sourceCommit, sourceCommit);
      assert.equal(run.buildVersion, version);
      report.runs.push({ id: run.id, testId: test.id, status: run.status, acceptance: run.acceptance,
        fixtureId: run.fixtureId, identity: run.identity, steps: run.steps, trace: run.trace, error: run.error });
      await writeFile(reportPath, JSON.stringify(report, null, 2));
      console.log(`${run.status}: ${test.id} (${run.id})${run.error ? ` — ${run.error}` : ''}`);
      if (run.status !== 'passed') break;
    }
  }
  assert.equal(new Set(report.runs.map(run => run.fixtureId)).size, report.runs.length);
  if (report.runs.length !== 12 || report.runs.some(run => run.status !== 'passed')) process.exitCode = 1;
} finally {
  await host?.stop();
  await dashboard?.stop();
  await writeFile(reportPath, JSON.stringify(report, null, 2));
}
