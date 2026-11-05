import assert from 'node:assert/strict';
import test from 'node:test';
import { dotnetBuild, nativeCompilerCrash } from '../src/dotnet-build.mjs';

const crash = 'C:\\Program Files\\dotnet\\sdk\\9.0.317\\Roslyn\\Microsoft.CSharp.Core.targets(84,5): error : Fatal error. 0xC0000005 [VirtualCompany.Persistence.Migrations.History1.csproj]';
const cscCrash = 'C:\\Program Files\\dotnet\\sdk\\9.0.317\\Roslyn\\Microsoft.CSharp.Core.targets(84,5): error MSB6006: "csc.dll" exited with code -1073741819. [VirtualCompany.Persistence.Migrations.History3.csproj]';
test('Roslyn managed access-violation diagnostic receives the same bounded compiler recovery', async () => {
  const managedCrash = crash.replace('0xC0000005', 'System.AccessViolationException: Attempted to read or write protected memory.');
  let calls = 0;
  await dotnetBuild(['build'], {}, async () => ++calls === 1 ? {code:1, output:managedCrash} : {code:0, output:'Build succeeded.'});
  assert.equal(calls,2);
  assert.equal(nativeCompilerCrash(managedCrash.replace('Microsoft.CSharp.Core.targets','Application.exe')),false);
  assert.equal(nativeCompilerCrash(managedCrash.replace('error : Fatal error.','warning : Fatal error.')),false);
});
test('MSBuild csc.dll access-violation exit from the failed invoice generation gets one fresh-process retry', async () => {
  let calls = 0; const logs = [];
  await dotnetBuild(['build', 'Host.csproj'], { log: line => logs.push(line) }, async (_command, _args, options) => {
    const output = ++calls === 1 ? cscCrash : 'Build succeeded.'; options.log(output); return { code: calls === 1 ? 1 : 0, output };
  });
  assert.equal(calls, 2); assert(logs.join('').includes(cscCrash));
  for (const code of ['3221225477', '0xC0000005']) assert(nativeCompilerCrash(cscCrash.replace('-1073741819', code)));
});
test('Virtual Company build recovers once from the exact native compiler crash and retains its log', async () => {
  const calls = [], logs = [], args = ['build', 'Host.csproj', '--disable-build-servers', '-maxcpucount:1'];
  await dotnetBuild(args, { cwd: 'isolated', log: value => logs.push(value) }, async (command, actual, options) => {
    calls.push({ command, args: actual }); assert.equal(options.allowFailure, true); options.log(calls.length === 1 ? crash : 'Build succeeded.');
    return calls.length === 1 ? { code: 1, output: crash } : { code: 0, output: 'Build succeeded.' };
  });
  assert.equal(calls.length, 2); assert.deepEqual(calls[0], calls[1]); assert.deepEqual(calls[0].args, args);
  assert(logs.join('').includes(crash)); assert.match(logs.join(''), /Retrying this build once/);
});
test('ordinary C# errors and application access violations do not trigger compiler recovery', async () => {
  for (const output of ['file.cs(1,1): error CS0103: Missing symbol', 'Application.exe: Fatal error. 0xC0000005', 'Microsoft.CSharp.Core.targets: error : Out of memory.',
    cscCrash.replace('-1073741819', '1'), cscCrash.replace('csc.dll', 'Application.exe'), 'Microsoft.CSharp.Core.targets: warning CS8602\nApplication.exe: error : Fatal error. 0xC0000005']) {
    let calls = 0; await assert.rejects(dotnetBuild(['build'], {}, async () => { calls++; return { code: 1, output }; }), /dotnet build exited/); assert.equal(calls, 1);
  }
  assert.equal(nativeCompilerCrash('warning CS8602: possibly null'), false);
});
test('native compiler recovery is bounded and reports the compiler error ahead of warning-tail noise', async () => {
  let calls = 0;
  await assert.rejects(dotnetBuild(['build'], {}, async () => { calls++; return { code: 1, output: crash + '\n' + 'warning CS8602: noise\n'.repeat(100) }; }), /after one native-compiler recovery attempt.*Fatal error/s);
  assert.equal(calls, 2);
});
test('aborted builds are not retried even if their captured output contains the compiler crash', async () => {
  const stop = new AbortController(); let calls = 0;
  await assert.rejects(dotnetBuild(['build'], { signal: stop.signal }, async () => { calls++; stop.abort(new Error('Build cancelled')); return { code: 1, output: crash }; }), /Build cancelled/);
  assert.equal(calls, 1);
});
