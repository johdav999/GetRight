import assert from 'node:assert/strict';
import test from 'node:test';
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
