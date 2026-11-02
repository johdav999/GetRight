// A separate owner remains alive if the worker crashes. Node closes the IPC
// channel on parent death; this owner then stops only the child it spawned.
import { spawn } from 'node:child_process';
import { stopProcess } from './processes.mjs';

const [command, ...args] = process.argv.slice(2);
const child = spawn(command, args, { shell: false, windowsHide: true,
  detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
let finished = false, stopping;
const disconnect = () => { if (process.connected) process.disconnect(); };
const stop = () => stopping ??= (async () => {
  if (finished) return;
  try { await stopProcess(child); }
  catch (error) { process.stderr.write(`Owned process shutdown failed: ${error.message}\n`); }
  process.exitCode = 1; disconnect();
})();
// Parent death may also close its log pipes before IPC disconnect arrives.
process.stdout.on('error', () => { void stop(); });
process.stderr.on('error', () => { void stop(); });
child.once('error', error => process.stderr.write(`${error.message}\n`));
child.once('close', code => { finished = true; process.exitCode = code ?? 1; disconnect(); });
process.once('disconnect', () => { void stop(); });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void stop(); });
