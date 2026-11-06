// Opt-in real WriterApp verification. Requires the isolated host to be running.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { repositoryRoot, localUrl, api } from '../src/settings.mjs';
import { executeRun, workerClaim } from '../src/run-execution.mjs';

const receiptPath = process.argv[2];
if (!receiptPath) throw new Error('Pass the build-receipt.json path printed by scripts/start-writerapp.ps1.');
const target = JSON.parse((await readFile(path.resolve(repositoryRoot, receiptPath), 'utf8')).replace(/^\uFEFF/, ''));
localUrl(target.baseUrl);
if (target.applicationId !== 'writerapp' || !target.isolatedDataConfirmed || target.expectedUserId !== 'dev-oid' ||
    target.authenticationMode !== 'development-fixed-identity' || !/^[a-f0-9]{32}$/.test(target.instanceId ?? '')) throw new Error('A Getright isolated WriterApp receipt is required.');
const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
const origin = `http://127.0.0.1:${probe.address().port}`; await new Promise(resolve => probe.close(resolve));
const dataPath = path.join(repositoryRoot, '.local', `writerapp-live-${Date.now()}`); await mkdir(dataPath, { recursive: true });
const projectPath = path.join(repositoryRoot, 'src/Getright.Dashboard');
const server = spawn('dotnet', [path.join(projectPath, 'bin/Release/net10.0/Getright.Dashboard.dll'), '--urls', origin], {
  cwd: projectPath, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, ASPNETCORE_ENVIRONMENT: 'Production', Getright__DataPath: dataPath },
});
let logs = ''; server.stdout.on('data', value => { logs += value; }); server.stderr.on('data', value => { logs += value; });
try {
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw new Error(`Dashboard exited: ${logs}`);
    try { await api(origin, '/api/health'); break; } catch { await delay(200); }
  }
  await api(origin, '/api/applications/writerapp/profile', target);
  const readiness = await api(origin, '/api/applications/writerapp/readiness');
  assert(readiness.ready, readiness.message);
  const run = await api(origin, '/api/runs', { testId: 'writerapp-create-save' });
  const claim = await api(origin, '/api/worker/claim', workerClaim); assert.equal(claim.run.id, run.id);
  const result = await executeRun(claim, { dashboardUrl: origin, dataPath, headless: true });
  await writeFile(path.join(dataPath, 'live-report.json'), JSON.stringify({ scope: 'Actual local WriterApp build and new isolated SQLite database; development test identity; no provider, external authentication or multi-user acceptance.', sourceCommit: target.sourceCommit, sourceWasDirty: target.sourceWasDirty, result }, null, 2));
  assert.equal(result.status, 'passed', `${result.error}\nEvidence: ${dataPath}`);
  assert.equal(result.identity.evidenceKind, 'live-application');
  assert.equal(result.acceptance, 'pending');
  console.log(`PASS: actual WriterApp create/save/reload with backend readback; human acceptance pending.\nBuild: ${result.buildVersion}\nEvidence: ${dataPath}`);
} finally {
  if (server.exitCode === null) { const exited = once(server, 'exit'); server.kill(); await exited; }
}
