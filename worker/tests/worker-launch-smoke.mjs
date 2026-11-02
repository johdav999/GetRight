// Actual supervised worker and Playwright, disposable dashboard/demo only.
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { api, repositoryRoot } from '../src/settings.mjs';
import { cleanEnvironment, runCommand } from '../src/processes.mjs';
import { dashboardHost } from './dashboard-host.mjs';

const dataPath = path.join(repositoryRoot, '.local', `worker-launch-${Date.now()}`), dashboard = await dashboardHost(dataPath);
const report = { scope: 'Actual supervised worker with disposable demo; no Codex/application/provider execution', flows: [], issues: [] };
const environment = { ...cleanEnvironment(), GETRIGHT_DASHBOARD_URL: dashboard.origin, GETRIGHT_DATA_PATH: dataPath, GETRIGHT_HEADLESS: 'true' };
const launch = () => runCommand(process.execPath, [fileURLToPath(new URL('../src/launch.mjs', import.meta.url)), '--once'], { env: environment, signal: AbortSignal.timeout(20000), allowFailure: true });
try {
  const empty = await launch(); assert.equal(empty.code, 0, empty.output); assert.match(empty.output, /No queued tests/);
  const queued = await api(dashboard.origin, '/api/runs', { testId: 'getright-save-note' });
  const executed = await launch(); assert.equal(executed.code, 0, executed.output); assert.match(executed.output, /Result: passed/);
  const result = await api(dashboard.origin, `/api/runs/${queued.id}`); assert.equal(result.status, 'passed', result.error); assert.equal(result.acceptance, 'pending');
  report.flows.push({ id: 'WORKER-001', name: 'Actual empty and queued --once child exits without an IPC hang; demo evidence saved with pending acceptance', status: 'verified', runId: result.id });
  console.log(`PASS: supervised worker --once lifecycle, demo execution and independent acceptance. Evidence: ${dataPath}`);
} finally { await dashboard.stop(); await writeFile(path.join(dataPath, 'worker-launch-report.json'), JSON.stringify(report, null, 2)); }
