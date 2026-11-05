import path from 'node:path';
import { mkdir, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { repositoryRoot, api, localUrl } from './settings.mjs';
import { jobConfiguration } from './jobs.mjs';
import { runCommand, cleanEnvironment, boundedLog } from './processes.mjs';
import { buildVersion } from './writerapp-host.mjs';
import { buildVirtualCompany, launchVirtualCompany } from './virtual-company-host.mjs';
import { requireBuildSpace } from './storage.mjs';

const controller = new AbortController();
for (const event of ['SIGINT', 'SIGTERM']) process.once(event, () => controller.abort(new Error('Local UAT instance stopped.')));
async function start() {
const id = randomUUID().replaceAll('-', '');
const dashboardOrigin = process.env.GETRIGHT_DASHBOARD_URL ? localUrl(process.env.GETRIGHT_DASHBOARD_URL) : null;
if (dashboardOrigin) {
  try {
    const health = await api(dashboardOrigin, '/api/health');
    if (health?.name !== 'Getright' || health.mode !== 'local' || !health.version) throw new Error('Unexpected dashboard health response.');
  } catch {
    throw new Error(`Cannot connect to a healthy local Getright dashboard at ${dashboardOrigin}. Start scripts/start-dashboard.ps1 -Background -Url ${dashboardOrigin}, then retry scripts/start-virtual-company.ps1. No Virtual Company worktree or host was created.`);
  }
}
const options = await jobConfiguration({}, 'virtual-company');
const root = path.join(repositoryRoot, 'data/virtual-company', id); await mkdir(root, { recursive: true });
const hooks = path.join(root, 'empty-hooks'); await mkdir(hooks);
const log = boundedLog(path.join(root, 'build.log'));
const git = (cwd, args) => runCommand('git', ['-c', 'core.longpaths=true', '-c', `core.hooksPath=${hooks}`, '-C', cwd, ...args], { env: cleanEnvironment(), signal: controller.signal });
const repository = (await git(options.repositoryPath, ['rev-parse', '--show-toplevel'])).output.trim();
const normalize = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
if (normalize(repository) !== normalize(options.repositoryPath)) throw new Error('The configured Virtual Company repository must be its Git root.');
const base = (await git(options.repositoryPath, ['rev-parse', 'HEAD'])).output.trim();
await mkdir(options.worktreeRoot, { recursive: true });
const worktreeRoot = await realpath(options.worktreeRoot);
const relative = path.relative(repository, worktreeRoot);
if (!relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))) throw new Error('The worktree root must be outside the original Virtual Company checkout.');
const tree = path.join(worktreeRoot, `vc-${id.slice(0, 8)}`);
if (process.platform === 'win32' && tree.length > 110) throw new Error('Choose a shorter worktreeRoot in local worker configuration.');
let host;
try {
  await requireBuildSpace([worktreeRoot, root], 'virtual-company');
  console.log(`Preparing clean Virtual Company source at ${base}. Logs: ${root}`);
  await git(options.repositoryPath, ['worktree', 'add', '--no-checkout', '--detach', tree, base]);
  await git(tree, ['sparse-checkout', 'set', '--no-cone', '/*', '!/*/', '/src/', '/tests/', '/docs/', '/.design-addin/', '/.agents/', '!/src/VirtualCompany.Api/App_Data/']);
  await git(tree, ['checkout', 'HEAD']);
  const build = await buildVirtualCompany({ worktree: tree, jobRoot: root, version: buildVersion(id), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(options.buildTimeoutMs)]), log });
  if ((await git(tree, ['status', '--porcelain'])).output.trim()) throw new Error('The baseline build modified source. Review the worktree before using it.');
  host = await launchVirtualCompany({ build, resultCommit: base, signal: controller.signal, log: boundedLog(path.join(root, 'launch.log')) });
  if (dashboardOrigin) {
    await api(dashboardOrigin, '/api/applications/virtual-company/profile', host.target);
    console.log('Launch receipt saved to Getright application setup.');
  }
  console.log(`Virtual Company: ${host.target.baseUrl}\nLaunch receipt: ${path.join(root, 'host/build-receipt.json')}\nCtrl+C stops only this instance. Its database is discarded; source and evidence are retained.`);
  await new Promise(resolve => { if (controller.signal.aborted) resolve(); else controller.signal.addEventListener('abort', resolve, { once: true }); });
} catch (error) {
  console.error(`Virtual Company UAT startup failed: ${error.message}\nFull local logs: ${root}`);
  process.exitCode = 1;
} finally { await host?.stop(); }
}
await start().catch(error => {
  console.error(`Virtual Company UAT startup failed: ${error.message}`);
  process.exitCode = 1;
});
