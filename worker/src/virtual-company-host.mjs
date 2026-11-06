import path from 'node:path';
import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { repositoryRoot, localUrl } from './settings.mjs';
import { cleanEnvironment, launchProcess, stopProcess } from './processes.mjs';
import { dotnetBuild } from './dotnet-build.mjs';
import { freePort } from './writerapp-host.mjs';

export async function buildVirtualCompany({ worktree, jobRoot, version, signal, log }) {
  const root = path.join(worktree, '.codex-build/getright-host');
  await mkdir(root, { recursive: true }); await mkdir(jobRoot, { recursive: true });
  const template = path.join(repositoryRoot, 'worker/hosts/virtual-company');
  await copyFile(path.join(template, 'Program.cs'), path.join(root, 'Program.cs'));
  await copyFile(path.join(template, 'FinanceUat.cs'), path.join(root, 'FinanceUat.cs'));
  await copyFile(path.join(template, 'Host.csproj.template'), path.join(root, 'Host.csproj'));
  // MSBuild's one-project limit does not serialize Roslyn's own compilation.
  // Large migration snapshots have crashed during parallel metadata emission.
  // Keep the UAT compiler process private and its internal emission sequential.
  const compilerResponse = path.join(root, 'compiler.rsp');
  await writeFile(compilerResponse, '/parallel-\n');
  const env = { ...cleanEnvironment(), DOTNET_CLI_HOME: path.join(repositoryRoot, '.local/dotnet'), DOTNET_CLI_TELEMETRY_OPTOUT: '1', MSBUILDDISABLENODEREUSE: '1' };
  // Migration-history projects are large. Keep compiler memory bounded on a
  // developer workstation that may also be running the apps and dashboard.
  for (const project of ['src/VirtualCompany.Web/VirtualCompany.Web.csproj', '.codex-build/getright-host/Host.csproj'])
    await dotnetBuild(['build', project, '--disable-build-servers', '-maxcpucount:1', '-p:UseSharedCompilation=false',
      `-p:CompilerResponseFile=${compilerResponse}`, `-p:AssemblyVersion=${version}`, `-p:Version=${version}`], { cwd: worktree, env, signal, log });
  const web = path.join(worktree, 'src/VirtualCompany.Web/bin/Debug/net9.0/VirtualCompany.Web.dll');
  const assembly = path.join(root, 'bin/Debug/net9.0/Getright.VirtualCompany.Host.dll');
  const digest = createHash('sha256').update(await readFile(web)).digest('hex');
  return { worktree, jobRoot, version, web, assembly, digest };
}

// One origin keeps browser evidence self-contained. All upstreams are fixed
// owned loopback processes. WebSocket forwarding is required by Blazor Server.
export async function virtualCompanyGateway({ apiOrigin, webOrigin, runtimeCheck = async () => {} }) {
  apiOrigin = localUrl(apiOrigin); webOrigin = localUrl(webOrigin);
  const sockets = new Set();
  const gateway = http.createServer(async (req, res) => {
    try {
      if (!req.url.startsWith('/') || req.url.startsWith('//')) { res.writeHead(400); res.end(); return; }
      if (req.url === '/_getright/runtime') await runtimeCheck();
      const target = new URL(req.url, req.url.startsWith('/api/') || req.url.startsWith('/_getright/') ? apiOrigin : webOrigin);
      const upstream = http.request(target, { method: req.method, headers: { ...req.headers, host: target.host } }, response => {
        res.writeHead(response.statusCode, response.headers); response.pipe(res);
      });
      upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      req.on('aborted', () => upstream.destroy()); req.pipe(upstream);
    } catch { res.writeHead(503); res.end('The owned UAT build is unavailable or changed.'); }
  });
  gateway.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  gateway.on('upgrade', (req, socket, head) => {
    if (!req.url.startsWith('/') || req.url.startsWith('//')) { socket.destroy(); return; }
    const target = new URL(req.url, webOrigin);
    const upstream = http.request(target, { headers: { ...req.headers, host: target.host } });
    upstream.on('upgrade', (response, peer, extra) => {
      socket.write(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n${Object.entries(response.headers).map(([key, value]) => `${key}: ${value}`).join('\r\n')}\r\n\r\n`);
      if (extra.length) socket.write(extra); if (head.length) peer.write(head);
      sockets.add(peer); peer.once('close', () => sockets.delete(peer));
      socket.on('error', () => peer.destroy()); peer.on('error', () => socket.destroy());
      socket.once('close', () => peer.destroy()); peer.once('close', () => socket.destroy());
      socket.pipe(peer).pipe(socket);
    });
    upstream.on('error', () => socket.destroy()); upstream.on('response', () => socket.destroy()); upstream.end();
  });
  gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening');
  return { origin: `http://127.0.0.1:${gateway.address().port}`, stop: async () => {
    for (const socket of sockets) socket.destroy(); await new Promise(resolve => gateway.close(resolve));
  } };
}

export async function launchVirtualCompany({ build, resultCommit, signal, log }) {
  signal?.throwIfAborted();
  const apiOrigin = `http://127.0.0.1:${await freePort()}`, webOrigin = `http://127.0.0.1:${await freePort()}`;
  const hostRoot = path.join(build.jobRoot, 'host'); await mkdir(hostRoot, { recursive: true });
  const env = { ...cleanEnvironment(), ASPNETCORE_ENVIRONMENT: 'Development', DOTNET_ENVIRONMENT: 'Development',
    DataProtection__KeyRingPath: path.join(hostRoot, 'keys'), GETRIGHT_WEB_ASSEMBLY: build.web };
  const children = []; let gateway;
  const check = async () => {
    for (const child of children) if (child.exitCode !== null || child.signalCode !== null) throw new Error('Virtual Company UAT process exited. See launch.log.');
    if (createHash('sha256').update(await readFile(build.web)).digest('hex') !== build.digest) throw new Error('The compiled Virtual Company web build changed.');
  };
  let stopping;
  const stop = () => stopping ??= (async () => { signal?.removeEventListener('abort', abort); await gateway?.stop(); await Promise.all(children.map(stopProcess)); })();
  const abort = () => { void stop().catch(log); };
  try {
    children.push(launchProcess('dotnet', [build.assembly, '--urls', apiOrigin], { cwd: build.worktree, env, log }));
    children.push(launchProcess('dotnet', [build.web, '--urls', webOrigin, '--ApiBaseUrl', apiOrigin,
      '--DevelopmentAuth:Subject', 'getright-owner', '--DevelopmentAuth:Email', 'getright-owner@example.invalid', '--DevelopmentAuth:DisplayName', 'Getright owner'],
    { cwd: path.join(build.worktree, 'src/VirtualCompany.Web'), env: { ...env, ASPNETCORE_STATICWEBASSETS: path.join(path.dirname(build.web), 'VirtualCompany.Web.staticwebassets.runtime.json') }, log }));
    let launchError; for (const child of children) child.on('error', error => { launchError = error; });
    gateway = await virtualCompanyGateway({ apiOrigin, webOrigin, runtimeCheck: check });
    signal?.addEventListener('abort', abort, { once: true });
    let runtime; const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      signal?.throwIfAborted(); if (launchError) throw launchError; await check();
      try {
        const response = await fetch(`${gateway.origin}/_getright/runtime`, { signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(1500)]), redirect: 'error' });
        if (response.ok) { runtime = await response.json(); break; }
      } catch { signal?.throwIfAborted(); }
      await delay(500, undefined, { signal });
    }
    if (!runtime || runtime.version !== build.version || runtime.role !== 'owner' || !runtime.isolated) throw new Error('The isolated Virtual Company runtime did not verify its build and owner.');
    const target = { applicationId: 'virtual-company', baseUrl: gateway.origin, expectedBuildVersion: build.version,
      expectedUserId: runtime.userId, expectedCompanyId: runtime.companyId, expectedRole: runtime.role,
      isolatedDataConfirmed: true, sourceCommit: resultCommit, sourceWasDirty: false };
    await writeFile(path.join(hostRoot, 'build-receipt.json'), JSON.stringify({ ...target, webAssemblySha256: build.digest }, null, 2));
    return { target, stop };
  } catch (error) { await stop(); throw error; }
}
