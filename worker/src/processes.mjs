import { spawn, execFile } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const commonEnvironment = new Set(['PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR', 'DOTNET_ROOT', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROCESSOR_ARCHITECTURE', 'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE', 'LANG', 'LC_ALL']);
export function cleanEnvironment(environment = process.env, codex = false) {
  const result = {};
  for (const [key, value] of Object.entries(environment)) {
    if (value !== undefined && (commonEnvironment.has(key.toUpperCase()) || (codex && ['CODEX_HOME', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL'].includes(key)))) result[key] = value;
  }
  return result;
}

export function boundedLog(file, limit = 2 * 1024 * 1024) {
  writeFileSync(file, ''); let used = 0, truncated = false;
  return chunk => {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    const remaining = Math.max(0, limit - used);
    if (remaining) { const selected = data.subarray(0, remaining); appendFileSync(file, selected); used += selected.length; }
    if (data.length > remaining && !truncated) { appendFileSync(file, '\n[Getright log limit reached; further output omitted.]\n'); truncated = true; }
  };
}

export async function stopProcess(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  // Only a ChildProcess created by this worker is accepted. No PID comes from API input.
  if (process.platform === 'win32') {
    await new Promise(resolve => execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 3000 }, () => resolve()));
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { } }
  }
  for (let i = 0; i < 30 && child.exitCode === null && child.signalCode === null; i++) await delay(100);
  if (child.exitCode === null && child.signalCode === null) {
    try { process.platform === 'win32' ? child.kill() : process.kill(-child.pid, 'SIGKILL'); } catch { }
    for (let i = 0; i < 20 && child.exitCode === null && child.signalCode === null; i++) await delay(100);
    if (child.exitCode === null && child.signalCode === null) throw new Error(`Could not stop owned process ${child.pid}.`);
  }
}

export function launchProcess(command, args, { cwd, env, log = () => {} } = {}) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./process-host.mjs', import.meta.url)), command, ...args], { cwd, env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  child.stdout.on('data', log); child.stderr.on('data', log);
  return child;
}

export async function runCommand(command, args, { cwd, env = cleanEnvironment(), signal, log = () => {}, allowFailure = false } = {}) {
  signal?.throwIfAborted();
  let output = ''; const capture = chunk => { log(chunk); if (output.length < 2 * 1024 * 1024) output += chunk.toString().slice(0, 2 * 1024 * 1024 - output.length); };
  const child = launchProcess(command, args, { cwd, env, log: capture });
  let rejectInterrupted;
  const interrupted = new Promise((_, reject) => { rejectInterrupted = reject; });
  const abort = () => { void stopProcess(child).then(() => rejectInterrupted(signal.reason), rejectInterrupted); };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  try {
    const closed = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', code => resolve({ code, output }));
    });
    const result = await Promise.race([closed, interrupted]);
    signal?.throwIfAborted();
    if (result.code !== 0 && !allowFailure) throw new Error(`${command} exited with code ${result.code}. ${output.slice(-1800)}`);
    return result;
  } finally { signal?.removeEventListener('abort', abort); await stopProcess(child); }
}
