// Native Windows launcher and cross-process database ownership checks.
// Uses copied build outputs and disposable databases, never the user's dashboard.
import assert from 'node:assert/strict';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { repositoryRoot, api } from '../src/settings.mjs';
import { cleanEnvironment, stopProcess } from '../src/processes.mjs';
import { freePort } from '../src/writerapp-host.mjs';

if (process.platform !== 'win32') throw new Error('The PowerShell launcher smoke requires Windows.');
const data = path.join(repositoryRoot, '.local', `startup-${Date.now()}`), checkout = path.join(data, 'checkout');
const sourceBuild = path.dirname(process.env.GETRIGHT_DASHBOARD_DLL || path.join(repositoryRoot, 'src/Getright.Dashboard/bin/Release/net10.0/Getright.Dashboard.dll'));
const binary = path.join(checkout, 'src/Getright.Dashboard/bin/Release/net10.0');
await mkdir(binary, { recursive: true }); await mkdir(path.join(checkout, 'scripts'));
await cp(sourceBuild, binary, { recursive: true });
for (const file of ['start-dashboard.ps1', 'stop-dashboard.ps1', 'dashboard-instance.ps1']) await cp(path.join(repositoryRoot, 'scripts', file), path.join(checkout, 'scripts', file));
const origin = `http://127.0.0.1:${await freePort()}`, dataPath = path.join(data, 'database');
const environment = { ...cleanEnvironment(), Getright__DataPath: dataPath };
const script = async (name, args = [], allowFailure = false) => {
  const child = spawn('powershell.exe', ['-NoProfile', '-File', path.join(checkout, 'scripts', name), '-Url', origin, ...args], { env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', part => { output += part; }); child.stderr.on('data', part => { output += part; });
  const timer = setTimeout(() => child.kill(), 30000);
  try {
    // A background Windows app can inherit unused pipe handles. The launcher
    // itself finishing is authoritative; do not wait for its app to close pipes.
    const [code] = await once(child, 'exit');
    if (code !== 0 && !allowFailure) throw new Error(`${name} ${args.join(' ')} failed (${code}): ${output}`);
    return { code, output };
  } finally { clearTimeout(timer); child.stdout.destroy(); child.stderr.destroy(); }
};
const report = { scope: 'Windows launchers and database instance lock; disposable data', flows: [], issues: [{
  id: 'STARTUP-001', severity: 'P1', observed: 'Starting the dashboard again tried to bind the occupied port, and startup recovery could touch a live instance database before binding failed.',
  expected: 'Reuse a healthy dashboard; explicitly restart only the verified idle instance; reject a second database owner before RunStore recovery.', status: 'open' }] };
let duplicate, other, ownedPid;
try {
  assert.match((await script('start-dashboard.ps1', ['-NoBuild', '-Background'])).output, /started in the background/);
  const first = await api(origin, '/api/health'); ownedPid = first.processId; assert(first.instanceId); assert.equal(first.dataPath.toLowerCase(), dataPath.toLowerCase());
  // No solution is copied: this proves repeated default startup returns before building.
  assert.match((await script('start-dashboard.ps1')).output, /already running/);
  assert.equal((await api(origin, '/api/health')).instanceId, first.instanceId);
  const run = await api(origin, '/api/runs', { testId: 'getright-save-note' });
  const claim = await api(origin, '/api/worker/claim', {});
  for (let i = 0; i < 102; i++) { const filler = await api(origin, '/api/runs', { testId: 'getright-save-note' }); await api(origin, `/api/runs/${filler.id}/cancel`, {}); }
  assert(!(await api(origin, '/api/runs')).some(r => r.id === run.id), 'The active original is intentionally older than the recent-100 window.');
  assert.equal((await api(origin, '/api/operations/active')).runs, 1);
  await api(origin, `/api/runs/${run.id}/heartbeat`, { lease: claim.lease });
  assert.match((await script('start-dashboard.ps1', ['-Restart', '-NoBuild', '-Background'], true)).output, /queued or running work/);
  assert.match((await script('stop-dashboard.ps1', [], true)).output, /queued or running work/);
  assert.equal((await api(origin, '/api/health')).instanceId, first.instanceId);
  assert.match((await script('start-dashboard.ps1')).output, /already running/);

  let logs = '';
  duplicate = spawn(path.join(binary, 'Getright.Dashboard.exe'), ['--urls', `http://127.0.0.1:${await freePort()}`], { cwd: path.join(checkout, 'src/Getright.Dashboard'), env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  duplicate.stdout.on('data', part => { logs += part; }); duplicate.stderr.on('data', part => { logs += part; });
  const [code] = await Promise.race([once(duplicate, 'exit'), new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Duplicate dashboard did not reject database ownership.')), 10000); timer.unref(); })]);
  assert.notEqual(code, 0); assert.match(logs, /data directory is already in use/);
  assert.equal((await api(origin, `/api/runs/${run.id}`)).status, 'running');
  await api(origin, `/api/runs/${run.id}/heartbeat`, { lease: claim.lease });
  report.flows.push({ id: 'START-001', name: 'Cold start, repeat startup, active work beyond recent-100 and duplicate database-owner refusal without invalidating leases', status: 'verified' });

  await api(origin, `/api/runs/${run.id}/cancel`, {});
  const terminal = await api(origin, `/api/runs/${run.id}/complete`, { lease: claim.lease, status: 'cancelled', steps: [] });
  const queuedId = 'b'.repeat(32), now = new Date().toISOString();
  const queuedCase = { id: queuedId, testId: 'getright-save-note', applicationId: 'getright', status: 'queued',
    testSnapshot: run.testSnapshot, definitionDigest: 'c'.repeat(64), approvedTarget: null, createdAt: now, updatedAt: now };
  const connection = new DatabaseSync(path.join(dataPath, 'getright.db'));
  for (const caseId of [queuedId, 'd'.repeat(32), 'e'.repeat(32)]) connection.prepare('INSERT INTO case_implementation_jobs(id,test_id,payload) VALUES(?,?,?)').run(caseId, queuedCase.testId, JSON.stringify({ ...queuedCase, id: caseId })); connection.close();
  const retainedCase = await api(origin, `/api/case-implementations/${queuedId}`);
  const retainedQueue = await api(origin, '/api/case-implementations');
  assert.match((await script('start-dashboard.ps1', ['-Restart', '-NoBuild', '-Background'], true)).output, /queued or running work/);
  assert.match((await script('start-dashboard.ps1', ['-Restart', '-PreserveQueued', '-NoBuild', '-Background'])).output, /Preserving 3 queued test implementations/);
  const queueReload = await api(origin, '/api/health'); ownedPid = queueReload.processId; assert.notEqual(queueReload.instanceId, first.instanceId);
  assert.deepEqual(await api(origin, `/api/case-implementations/${queuedId}`), retainedCase);
  assert.deepEqual(await api(origin, '/api/case-implementations'), retainedQueue);
  assert.deepEqual(await api(origin, `/api/runs/${run.id}`), terminal);
  const caseClaim = await api(origin, '/api/worker/case-implementations/claim', {});
  assert.match((await script('start-dashboard.ps1', ['-Restart', '-PreserveQueued', '-NoBuild', '-Background'], true)).output, /queued or running work/);
  assert.equal((await api(origin, '/api/health')).instanceId, queueReload.instanceId);
  await api(origin, `/api/case-implementations/${queuedId}/finish`, { lease: caseClaim.lease, status: 'cancelled', error: 'Disposable startup fixture finished.' });
  for (const caseId of ['d'.repeat(32), 'e'.repeat(32)]) await api(origin, `/api/case-implementations/${caseId}/cancel`, {});
  report.flows.push({ id: 'START-004', name: 'Explicit stopped-worker queued upgrade retains jobs/history and still refuses executing implementations', status: 'verified' });
  assert.match((await script('start-dashboard.ps1', ['-Restart', '-NoBuild', '-Background'])).output, /started in the background/);
  const restarted = await api(origin, '/api/health'); ownedPid = restarted.processId; assert.notEqual(restarted.instanceId, first.instanceId);
  assert.deepEqual(await api(origin, `/api/runs/${run.id}`), terminal);
  assert.match((await script('stop-dashboard.ps1')).output, /Getright stopped/);
  ownedPid = null;
  assert.match((await script('stop-dashboard.ps1')).output, /No Getright dashboard/);
  assert.match((await script('start-dashboard.ps1', ['-NoBuild', '-Background'])).output, /started in the background/);
  const reopened = await api(origin, '/api/health'); ownedPid = reopened.processId; assert.notEqual(reopened.instanceId, restarted.instanceId);
  await script('stop-dashboard.ps1');
  ownedPid = null;
  report.flows.push({ id: 'START-002', name: 'Explicit idle restart and stop, retained history and reusable stale lock metadata', status: 'verified' });

  const occupiedPort = new URL(origin).port;
  let impersonate = false;
  other = http.createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(impersonate ? { name: 'Getright', mode: 'local', version: 'synthetic', instanceId: 'synthetic', processId: process.pid, dataPath } : { name: 'another-application' })); });
  other.listen(Number(occupiedPort), '127.0.0.1'); await once(other, 'listening');
  assert.match((await script('start-dashboard.ps1', ['-NoBuild', '-Background'], true)).output, /already in use and is not a healthy Getright/);
  assert.match((await script('stop-dashboard.ps1', [], true)).output, /not a healthy Getright/);
  impersonate = true;
  assert.match((await script('start-dashboard.ps1', ['-Restart', '-NoBuild', '-Background'], true)).output, /not this checkout/);
  assert.equal((await api(origin, '/api/health')).processId, process.pid, 'An unrelated listener must remain alive.');
  report.flows.push({ id: 'START-003', name: 'Occupied unrelated port and process-identity mismatch refuse without stopping the listener', status: 'verified' });
  report.issues[0].status = 'verified';
  console.log(`PASS: repeatable startup, safe restart/stop, unrelated-listener refusal and exclusive database ownership. Evidence: ${data}`);
} finally {
  await stopProcess(duplicate);
  if (other) await new Promise(resolve => other.close(resolve));
  try { await script('stop-dashboard.ps1'); } catch { }
  if (ownedPid && ownedPid !== process.pid) {
    try { const health = await api(origin, '/api/health'); if (health.processId === ownedPid && health.dataPath.toLowerCase() === dataPath.toLowerCase()) process.kill(ownedPid); } catch { }
  }
  await writeFile(path.join(data, 'startup-report.json'), JSON.stringify(report, null, 2));
}
