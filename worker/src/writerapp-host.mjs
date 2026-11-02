import path from 'node:path';
import { mkdir, writeFile, copyFile, access } from 'node:fs/promises';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { cleanEnvironment, runCommand, launchProcess, stopProcess } from './processes.mjs';
import { repositoryRoot, localUrl } from './settings.mjs';

export function buildVersion(jobId) { return `0.2.${parseInt(jobId.slice(0, 4), 16)}.${parseInt(jobId.slice(4, 8), 16)}`; }

export async function buildWriterApp({ worktree, jobRoot, jobId, version, signal, log }) {
  // Each worktree has its own build. Short paths are needed by WebAssembly
  // build tools on Windows even when ordinary .NET paths support long names.
  if (process.platform === 'win32' && worktree.length > 110) throw new Error('The WriterApp worktree path is too long for a reliable Windows WebAssembly build.');
  const relativeRoot = 'artifacts/gr';
  const args = ['build', 'BlazorApp.csproj', '--disable-build-servers', `-p:BaseOutputPath=${relativeRoot}/bin/`, `-p:BaseIntermediateOutputPath=${relativeRoot}/obj/`, `-p:AssemblyVersion=${version}`, `-p:Version=${version}`];
  const env = { ...cleanEnvironment(), DOTNET_CLI_HOME: path.join(repositoryRoot, '.local/dotnet'), DOTNET_CLI_TELEMETRY_OPTOUT: '1', MSBUILDDISABLENODEREUSE: '1' };
  await mkdir(jobRoot, { recursive: true });
  await runCommand('dotnet', args, { cwd: worktree, env, signal, log });
  const output = path.join(worktree, relativeRoot, 'bin/Debug/net10.0');
  const assembly = path.join(output, 'BlazorApp.dll');
  const manifest = path.join(output, 'BlazorApp.staticwebassets.runtime.json');
  await access(assembly); await access(manifest);
  return { assembly, manifest, worktree, jobRoot, version };
}

export async function freePort() {
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve)); return port;
}

export async function verifyRuntime(baseUrl, version, { signal, timeoutMs = 90000, checkProcess = () => {} } = {}) {
  localUrl(baseUrl);
  const deadline = Date.now() + timeoutMs;
  let lastFailure = 'No runtime response received.';
  while (Date.now() < deadline) {
    signal?.throwIfAborted(); checkProcess();
    try {
      const requestSignal = AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(Math.min(1500, Math.max(1, deadline - Date.now())))]);
      const response = await fetch(`${baseUrl}/api/app/version`, { redirect: 'error', signal: requestSignal });
      if (response.ok) {
        const identity = await response.json();
        if (identity.version !== version) throw new Error('The launched application reports a different build version.');
        return;
      }
      lastFailure = `Runtime endpoint returned HTTP ${response.status}.`;
    } catch (error) {
      if (error.message.includes('different build version')) throw error;
      lastFailure = `${error.message}${error.cause?.message ? `: ${error.cause.message}` : ''}`;
      signal?.throwIfAborted();
    }
    await delay(Math.min(500, Math.max(1, deadline - Date.now())), undefined, { signal });
  }
  throw new Error(`The changed WriterApp build did not become ready within ${Math.ceil(timeoutMs / 1000)} seconds. ${lastFailure}`);
}

export async function launchWriterApp({ build, resultCommit, signal, log }) {
  signal?.throwIfAborted();
  const hostRoot = path.join(build.jobRoot, 'host');
  const indexRoot = path.join(hostRoot, 'wwwroot/app'); await mkdir(indexRoot, { recursive: true });
  await copyFile(path.join(build.worktree, 'WriterApp.Client/wwwroot/index.html'), path.join(indexRoot, 'index.html'));
  const baseUrl = `http://127.0.0.1:${await freePort()}`;
  const connection = `Data Source="${path.join(hostRoot, 'writerapp.db').replaceAll('"', '""')}"`;
  const configuration = {
    DatabaseProvider: 'Sqlite', ConnectionStrings: { DefaultConnection: connection }, UseExternalIdAuth: false,
    AppUrls: { PublicBaseUrl: baseUrl }, Stripe: { Enabled: false }, Workflow: { ProjectsEnabled: false },
    WriterApp: { Database: { AutoMigrateOnStartup: true }, Auth: { DevAutoLogin: true, UseExternalIdAuth: false }, AI: { Enabled: false }, WasmClient: { Enabled: true } },
    Logging: { LogLevel: { Default: 'Warning', 'Microsoft.Hosting.Lifetime': 'Information' } },
  };
  await writeFile(path.join(hostRoot, 'appsettings.json'), JSON.stringify(configuration, null, 2));
  const env = { ...cleanEnvironment(),
    ASPNETCORE_ENVIRONMENT: 'Development', DOTNET_ENVIRONMENT: 'Development', ASPNETCORE_STATICWEBASSETS: build.manifest,
    DatabaseProvider: 'Sqlite', ConnectionStrings__DefaultConnection: connection,
    WriterApp__Database__AutoMigrateOnStartup: 'true', WriterApp__AI__Enabled: 'false', Stripe__Enabled: 'false',
    UseExternalIdAuth: 'false', WriterApp__Auth__UseExternalIdAuth: 'false', WriterApp__WasmClient__Enabled: 'true',
    AppUrls__PublicBaseUrl: baseUrl, Collaboration__LocalTest__Enabled: 'false', Collaboration__SessionsEnabled: 'false',
    Collaboration__CommitsEnabled: 'false', Collaboration__Sharing__Enabled: 'false',
  };
  const child = launchProcess('dotnet', [build.assembly, '--contentRoot', hostRoot, '--urls', baseUrl], { cwd: build.worktree, env, log });
  let launchError; child.once('error', error => { launchError = error; });
  const abort = () => { void stopProcess(child).catch(error => { launchError = error; }); }; signal?.addEventListener('abort', abort, { once: true });
  const stop = async () => { signal?.removeEventListener('abort', abort); await stopProcess(child); };
  try {
    await verifyRuntime(baseUrl, build.version, { signal, checkProcess: () => {
      if (launchError) throw launchError;
      if (child.exitCode !== null) throw new Error(`The changed WriterApp host exited (${child.exitCode}). See launch.log.`);
    } });
    const target = { applicationId: 'writerapp', baseUrl, expectedBuildVersion: build.version, expectedUserId: 'dev-oid', isolatedDataConfirmed: true, sourceCommit: resultCommit, sourceWasDirty: false };
    await writeFile(path.join(hostRoot, 'build-receipt.json'), JSON.stringify(target, null, 2));
    return { target, stop };
  } catch (error) { log(`\nGetright runtime probe: ${error.message}\n`); await stop(); throw error; }
}
