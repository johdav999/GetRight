import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { cleanEnvironment, boundedLog, runCommand } from '../src/processes.mjs';
import { buildVersion } from '../src/writerapp-host.mjs';

test('build and runtime environments exclude inherited application secrets and database settings', () => {
  const environment = { PATH: '/bin', SystemRoot: 'C:\\Windows', ConnectionStrings__DefaultConnection: 'do-not-inherit', MailGunAPIKey: 'do-not-inherit', OPENAI_API_KEY: 'codex-only', CODEX_HOME: '/auth', HTTP_PROXY: 'proxy' };
  assert.deepEqual(cleanEnvironment(environment), { PATH: '/bin', SystemRoot: 'C:\\Windows', HTTP_PROXY: 'proxy' });
  assert.equal(cleanEnvironment(environment, true).OPENAI_API_KEY, 'codex-only');
  assert.equal(cleanEnvironment(environment, true).MailGunAPIKey, undefined);
});
test('job build versions are deterministic valid four-part assembly versions', () => {
  const version = buildVersion('abcdef01' + '0'.repeat(24));
  assert.equal(version, '0.2.43981.61185');
  assert(version.split('.').every(part => Number(part) <= 65535));
});
test('bounded child logs retain a single truncation marker', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'getright-log-'));
  const file = path.join(directory, 'build.log'); const log = boundedLog(file, 8);
  log('12345'); log('67890'); log('more');
  const content = await readFile(file, 'utf8');
  assert(content.startsWith('12345678')); assert.equal(content.match(/limit reached/g).length, 1);
});
test('owned child execution captures failures and honors cancellation', async () => {
  const result = await runCommand(process.execPath, ['-e', 'process.stdout.write("checked");process.exit(7)'], { allowFailure: true });
  assert.equal(result.code, 7); assert.equal(result.output, 'checked');
  await assert.rejects(runCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { signal: AbortSignal.timeout(300) }), /timeout|aborted/i);
});

test('a process owner stops its child when the worker dies without running finally', async () => {
  const module = new URL('../src/processes.mjs', import.meta.url).href;
  const script = `import { launchProcess } from ${JSON.stringify(module)}; const child=launchProcess(process.execPath,['-e','console.log(process.pid); setInterval(()=>{},1000)'],{env:process.env,log:value=>process.stdout.write(value)}); setInterval(()=>{},1000);`;
  const parent = spawn(process.execPath, ['--input-type=module', '-e', script], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', pid;
  parent.stdout.on('data', value => { output += value; });
  try {
    for (let i = 0; i < 100 && !/^\d+\s*$/.test(output); i++) await delay(50);
    pid = Number(output.trim()); assert(Number.isInteger(pid) && pid > 0, output);
    parent.kill(); // Kill only the worker, leaving its separate process owner alive.
    const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
    for (let i = 0; i < 120 && alive(); i++) await delay(50);
    assert.equal(alive(), false, 'The owned target must not survive its worker.');
  } finally {
    parent.kill();
    if (pid) { try { process.kill(pid); } catch { } }
  }
});
