import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { once } from 'node:events';
import { fork } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, readFile, unlink, appendFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { launchWorker } from '../src/launch.mjs';
import { workerSourceStamp, reloadExitCode } from '../src/worker-version.mjs';
import { cleanEnvironment } from '../src/processes.mjs';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'getright-reload-')); await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src/helper.mjs'), 'export const version = 1;'); await writeFile(path.join(root, 'package-lock.json'), '{}'); return root;
}
async function until(read, check) {
  for (let index = 0; index < 100; index++) { try { const value = await read(); if (check(value)) return value; } catch { } await delay(30); }
  throw new Error('Timed out waiting for the owned worker fixture.');
}
test('worker source stamp detects entry/support/lock changes while ignoring run data', async () => {
  const root = await fixture(), original = await workerSourceStamp(root);
  await writeFile(path.join(root, 'screenshot.png'), 'local evidence'); assert.equal(await workerSourceStamp(root), original);
  await writeFile(path.join(root, 'src/helper.mjs'), 'export const version = 2;'); const changed = await workerSourceStamp(root); assert.notEqual(changed, original);
  await writeFile(path.join(root, 'src/new-adapter.mjs'), 'export const adapter = 1;'); const added = await workerSourceStamp(root); assert.notEqual(added, changed);
  await writeFile(path.join(root, 'package-lock.json'), '{"lockfileVersion":3}'); assert.notEqual(await workerSourceStamp(root), added);
});
test('supervisor reloads changed worker only at its idle boundary and stops its owned child', async () => {
  const root = await fixture(), entry = path.join(root, 'src/index.mjs'), record = path.join(root, 'starts.jsonl'), busy = path.join(root, 'busy');
  const versionModule = new URL('../src/worker-version.mjs', import.meta.url).href;
  await writeFile(busy, 'owned work is active');
  await writeFile(entry, `import { appendFile, access } from 'node:fs/promises'; import { setTimeout as delay } from 'node:timers/promises'; import { workerSourceStamp, reloadExitCode } from ${JSON.stringify(versionModule)};
await appendFile(${JSON.stringify(record)}, JSON.stringify({ pid:process.pid, stamp:process.env.GETRIGHT_WORKER_SOURCE_STAMP })+'\\n');
process.on('message', m=>{if(m.type==='getright-stop') process.exit(0)}); process.on('disconnect',()=>process.exit(0));
for(;;){await delay(20);let active=true;try{await access(${JSON.stringify(busy)})}catch{active=false}if(!active && await workerSourceStamp(${JSON.stringify(root)})!==process.env.GETRIGHT_WORKER_SOURCE_STAMP)process.exit(reloadExitCode);}`);
  const stop = new AbortController(), logs = [];
  const running = launchWorker({ entry, sourceRoot: root, args: [], signal: stop.signal, log: text => logs.push(text), stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const starts = async () => (await readFile(record, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  try {
    const first = (await until(starts, value => value.length === 1))[0];
    await appendFile(path.join(root, 'src/helper.mjs'), '\n// source update'); await delay(150); assert.equal((await starts()).length, 1, 'Active work must finish before reload.');
    await unlink(busy); const next = await until(starts, value => value.length === 2); assert.notEqual(next[1].pid, first.pid); assert.notEqual(next[1].stamp, first.stamp);
    assert.equal(logs.length, 1); stop.abort(); assert.equal(await running, 0);
    assert.throws(() => process.kill(next[1].pid, 0), 'The stopped supervisor must leave no worker.');
  } finally { stop.abort(); await running; }
});
test('supervisor does not retry ordinary failures', async () => {
  const root = await fixture(), entry = path.join(root, 'src/index.mjs'), record = path.join(root, 'starts.txt');
  await writeFile(entry, `import {appendFile} from 'node:fs/promises';await appendFile(${JSON.stringify(record)},'started\\n');process.exit(7);`);
  assert.equal(await launchWorker({ entry, sourceRoot: root, args: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }), 7);
  assert.equal(await readFile(record, 'utf8'), 'started\n');
});
test('stale actual forked worker disconnects and exits for reload before claiming any queue', async () => {
  let claims = 0; const server = http.createServer((req, res) => { claims++; res.end('null'); }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  let child;
  try {
    child = fork(fileURLToPath(new URL('../src/index.mjs', import.meta.url)), ['--once'], { windowsHide: true,
      env: { ...cleanEnvironment(), GETRIGHT_DASHBOARD_URL: `http://127.0.0.1:${server.address().port}`, GETRIGHT_WORKER_SOURCE_STAMP: 'stale-fixture' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
    const timeout = setTimeout(() => child.kill(), 5000);
    try { const [code] = await once(child, 'exit'); assert.equal(code, reloadExitCode, output); assert.match(output, /idle worker for reload/); assert.equal(claims, 0); }
    finally { clearTimeout(timeout); }
  } finally { if (child?.exitCode === null) child.kill(); await new Promise(resolve => server.close(resolve)); }
});
