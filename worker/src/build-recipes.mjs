import path from 'node:path';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { repositoryRoot } from './settings.mjs';
import { cleanEnvironment, launchProcess, runCommand, stopProcess } from './processes.mjs';
import { buildWriterApp, launchWriterApp, buildVersion, freePort } from './writerapp-host.mjs';
import { buildVirtualCompany, launchVirtualCompany } from './virtual-company-host.mjs';

const extensions = new Map([
  ['writerapp-dotnet', { applicationId: 'writerapp', build: buildWriterApp, launch: launchWriterApp, files: ['writerapp-host.mjs'] }],
  ['virtual-company-dotnet', { applicationId: 'virtual-company', build: async input => {
    const build = await buildVirtualCompany(input);
    return { ...build, staticManifests: [path.join(path.dirname(build.web), 'VirtualCompany.Web.staticwebassets.runtime.json')] };
  }, launch: launchVirtualCompany,
    files: ['virtual-company-host.mjs', 'dotnet-build.mjs', '../hosts/virtual-company/Program.cs',
      '../hosts/virtual-company/FinanceUat.cs', '../hosts/virtual-company/Host.csproj.template'] }],
]);
const idPattern = /^[a-z][a-z0-9-]{0,59}$/;
const relative = value => typeof value === 'string' && value.length <= 200 && !/\s/.test(value) && /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(value) &&
  !value.split('/').some(segment => segment === '.' || segment === '..');
const ownedPath = value => typeof value === 'string' && value.length <= 200 && !/\s/.test(value) && /^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/.test(value);
const variables = new Set(['worktree', 'output', 'artifact', 'data', 'origin', 'port', 'version', 'commit']);
const template = /\{\{([a-z]+)\}\}/g;
const allowedKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
const bundled = JSON.parse(await readFile(new URL('../../config/build-recipes.json', import.meta.url), 'utf8'));

function boundedTimeout(value, fallback, maximum = 3600000) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1000 || value > maximum) throw new Error('The recipe timeout is outside its supported range.');
  return value;
}

function command(value, build) {
  const valid = allowedKeys(value, build ? ['executable', 'script', 'args'] : ['executable', 'args']) && value.executable === 'node' &&
    (!build || relative(value.script)) && Array.isArray(value.args) && value.args.length <= 32 && value.args.every(arg =>
      typeof arg === 'string' && arg.length <= 1000 && !/[\u0000-\u001f]/.test(arg) &&
      [...arg.matchAll(template)].every(([, name]) => variables.has(name) && (!build || !['origin', 'port', 'data'].includes(name))) &&
      !arg.replace(template, '').includes('{{') && !arg.replace(template, '').includes('}}'));
  if (!valid) throw new Error('A process recipe requires bounded Node script arguments and known variables.');
}

function validateDefinition(spec, app, binding) {
  if (!allowedKeys(spec, ['version', 'applicationId', 'repositoryPath', 'sourceMarker', 'sparsePaths', 'extension', 'buildTimeoutMs', 'process']) ||
      spec.version !== binding.version || spec.applicationId !== app || !relative(spec.sourceMarker) ||
      (spec.repositoryPath !== undefined && (typeof spec.repositoryPath !== 'string' || !spec.repositoryPath.trim())) ||
      (spec.sparsePaths !== undefined && (!Array.isArray(spec.sparsePaths) || spec.sparsePaths.length > 32 || spec.sparsePaths.some(item =>
        typeof item !== 'string' || item.length > 200 || !/^!?\/[A-Za-z0-9_.*\/-]+$/.test(item) || item.split('/').includes('..')))))
    throw new Error('The selected build recipe does not match the trusted application binding.');
  if (spec.extension !== undefined) {
    const extension = extensions.get(spec.extension);
    if (!extension || extension.applicationId !== app || spec.process !== undefined) throw new Error('The selected host extension is not registered for this application.');
    return extension;
  }
  const recipe = spec.process;
  if (!allowedKeys(recipe, ['build', 'launch', 'artifact', 'readyPath', 'readyTimeoutMs']) || !relative(recipe.artifact) || !ownedPath(recipe.readyPath))
    throw new Error('A process recipe needs a relative entry artifact and a local readiness path.');
  command(recipe.build, true);
  command(recipe.launch, false);
  boundedTimeout(recipe.readyTimeoutMs, 90000, 180000);
  return null;
}

export async function jobConfiguration(configuration, applicationId = 'writerapp', selected = null) {
  const configPath = process.env.GETRIGHT_WORKER_CONFIG || path.join(repositoryRoot, 'config/worker.local.json');
  let local = {};
  try { local = JSON.parse((await readFile(configPath, 'utf8')).replace(/^\uFEFF/, '')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('The local worker configuration is not valid JSON.'); }
  const fallback = Object.entries(bundled).find(([, spec]) => spec.applicationId === applicationId);
  const recipe = selected ?? (fallback && { id: fallback[0], version: fallback[1].version });
  if (!recipe || !idPattern.test(recipe.id) || !Number.isInteger(recipe.version) || recipe.version < 1) throw new Error('No trusted build recipe is selected for this application.');
  const spec = Object.hasOwn(local.recipes ?? {}, recipe.id) ? local.recipes[recipe.id] :
    Object.hasOwn(bundled, recipe.id) ? bundled[recipe.id] : null;
  const extension = validateDefinition(spec, applicationId, recipe);
  const overrides = configuration.jobOptions || {};
  const repository = overrides.repositoryPath || local[applicationId]?.repositoryPath || spec.repositoryPath;
  if (!repository) throw new Error('The worker needs a local Git repository binding for this recipe.');
  const repositoryPath = await realpath(path.resolve(repositoryRoot, repository));
  const fingerprint = createHash('sha256').update(JSON.stringify({ recipe, spec, repositoryPath }));
  for (const file of ['build-recipes.mjs', 'processes.mjs', 'process-host.mjs', 'case-build.mjs', ...(extension?.files ?? [])]) {
    fingerprint.update(file).update(await readFile(new URL(file, import.meta.url)));
  }
  return {
    recipe, recipeDigest: fingerprint.digest('hex'), sourceMarker: spec.sourceMarker, sparsePaths: spec.sparsePaths ?? [],
    repositoryPath,
    worktreeRoot: path.resolve(repositoryRoot, overrides.worktreeRoot || local.worktreeRoot || 'worktrees'),
    codexTimeoutMs: boundedTimeout(overrides.codexTimeoutMs ?? local.codexTimeoutMs, 1800000),
    buildTimeoutMs: boundedTimeout(overrides.buildTimeoutMs ?? local.buildTimeoutMs ?? spec.buildTimeoutMs, 300000),
    model: overrides.model || local.codexModel || undefined,
    version: extension ? buildVersion : id => `getright-${id}`,
    sdkVersion: extension ? async (cwd, signal) => (await runCommand('dotnet', ['--version'], { cwd, signal })).output.trim() : async () => process.version,
    build: extension?.build ?? (input => buildProcess(spec.process, input)),
    launch: extension?.launch ?? (input => launchRecipe(spec.process, applicationId, input)),
  };
}

export async function prepareApplicationWorktree(git, options, repository, worktree, commit, { branch, created } = {}) {
  await git(repository, ['cat-file', '-e', `${commit}:${options.sourceMarker}`]);
  await git(repository, ['worktree', 'add', ...(options.sparsePaths.length ? ['--no-checkout'] : []),
    ...(branch ? ['-b', branch] : ['--detach']), worktree, commit]);
  await created?.();
  if (options.sparsePaths.length) {
    await git(worktree, ['sparse-checkout', 'set', '--no-cone', '--', ...options.sparsePaths]);
    await git(worktree, ['checkout', 'HEAD']);
  }
}

async function plainFile(root, file) {
  const candidate = path.resolve(root, file);
  const actual = await realpath(candidate);
  const normalize = value => process.platform === 'win32' ? value.toLowerCase() : value;
  if (normalize(actual) !== normalize(candidate) || !(await lstat(candidate)).isFile()) throw new Error('Recipe scripts and entry artifacts must be plain files inside their owned root.');
  return actual;
}

function argsFor(command, values) {
  return command.args.map(arg => arg.replace(template, (_, name) => {
    if (values[name] === undefined) throw new Error('A recipe variable is unavailable for this phase.');
    return String(values[name]);
  }));
}

function environment(values) {
  const env = cleanEnvironment();
  for (const key of Object.keys(env)) if (['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY'].includes(key.toUpperCase())) delete env[key];
  const fields = { version: 'GETRIGHT_BUILD_VERSION', commit: 'GETRIGHT_SOURCE_COMMIT', output: 'GETRIGHT_BUILD_OUTPUT',
    data: 'GETRIGHT_UAT_DATA', origin: 'GETRIGHT_UAT_ORIGIN', port: 'GETRIGHT_UAT_PORT' };
  for (const [name, key] of Object.entries(fields)) if (values[name] !== undefined) env[key] = String(values[name]);
  return env;
}

async function buildProcess(recipe, { worktree, jobRoot, version, resultCommit: commit, signal, log }) {
  const output = path.join(jobRoot, 'compiled');
  await mkdir(output);
  const artifact = path.join(output, recipe.artifact);
  const values = { worktree, output, artifact, version, commit };
  const script = await plainFile(worktree, recipe.build.script);
  await runCommand(process.execPath, [script, ...argsFor(recipe.build, values)], { cwd: worktree, env: environment(values), signal, log });
  await plainFile(output, recipe.artifact);
  return { worktree, jobRoot, output, artifact, artifactRoots: [output], version };
}

async function receiptJson(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('The recipe host did not return a readiness receipt.');
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > 65536) throw new Error('The recipe readiness receipt is too large.');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); }
}

async function launchRecipe(recipe, applicationId, { build, resultCommit, sourceTarget, signal, log }) {
  signal?.throwIfAborted();
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const data = path.join(build.jobRoot, 'host');
  await mkdir(data);
  const values = { worktree: build.worktree, output: build.output, artifact: await plainFile(build.output, recipe.artifact),
    data, origin, port, version: build.version, commit: resultCommit };
  const child = launchProcess(process.execPath, [values.artifact, ...argsFor(recipe.launch, values)], { cwd: build.output, env: environment(values), log });
  let launchError, stopping;
  child.once('error', error => { launchError = error; });
  const stop = () => stopping ??= stopProcess(child).finally(() => signal?.removeEventListener('abort', abort));
  const abort = () => { void stop().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const deadline = Date.now() + (recipe.readyTimeoutMs ?? 90000);
    for (;;) {
      signal?.throwIfAborted();
      if (launchError || child.exitCode !== null || child.signalCode !== null) throw new Error('The recipe host exited before readiness. See the launch log.');
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('The isolated recipe host did not become ready before its deadline.');
      const requestDeadline = AbortSignal.timeout(Math.min(remaining, 1500));
      let runtime;
      try {
        const response = await fetch(origin + recipe.readyPath, { redirect: 'error', signal: signal ? AbortSignal.any([signal, requestDeadline]) : requestDeadline });
        if (response.ok) runtime = await receiptJson(response);
        else await response.body?.cancel();
      } catch { /* A process may still be starting. No response contents go to logs. */ }
      if (runtime) {
        if (runtime.version !== build.version || runtime.sourceCommit !== resultCommit || runtime.isolated !== true || runtime.userId !== sourceTarget.expectedUserId ||
            (sourceTarget.expectedRole != null && (runtime.role !== sourceTarget.expectedRole ||
              !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(runtime.companyId ?? '') ||
              runtime.companyId.toLowerCase() === sourceTarget.expectedCompanyId?.toLowerCase())))
          throw new Error('The recipe host reported a different build, account or isolation scope.');
        signal?.throwIfAborted();
        return { target: { applicationId, baseUrl: origin, expectedBuildVersion: build.version, expectedUserId: runtime.userId,
          isolatedDataConfirmed: true, sourceCommit: resultCommit, sourceWasDirty: false,
          expectedCompanyId: sourceTarget.expectedRole == null ? null : runtime.companyId, expectedRole: sourceTarget.expectedRole ?? null }, stop };
      }
      await delay(150, undefined, { signal });
    }
  } catch (error) { await stop(); throw error; }
}

export function buildAttribution(options, artifactDigest) {
  return { recipe: options.recipe, recipeDigest: options.recipeDigest, artifactDigest };
}

export async function recordBuildReceipt(jobRoot, target, receipt) {
  const recorded = { ...target, buildReceipt: receipt };
  await writeFile(path.join(jobRoot, 'build-receipt.json'), JSON.stringify(recorded, null, 2), { flag: 'wx' });
  return recorded;
}
