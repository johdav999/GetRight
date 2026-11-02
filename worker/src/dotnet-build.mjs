import { runCommand } from './processes.mjs';

export function nativeCompilerCrash(output) {
  return /Microsoft\.CSharp\.Core\.targets/i.test(output) && /\berror\s*:\s*Fatal error\.\s*0xC0000005\b/i.test(output);
}

// Native access violations are intermittent compiler-process failures. Retry
// once in a fresh process; keep both attempts in the caller's bounded log.
// Ordinary diagnostics, cancellation and other exit codes are never retried.
export async function dotnetBuild(args, options, execute = runCommand) {
  for (let attempt = 0; attempt < 2; attempt++) {
    options.signal?.throwIfAborted();
    const result = await execute('dotnet', args, { ...options, allowFailure: true });
    options.signal?.throwIfAborted();
    if (result.code === 0) return;
    if (attempt === 0 && nativeCompilerCrash(result.output)) {
      options.log?.('\nGetright: the C# compiler crashed with 0xC0000005. Retrying this build once in a fresh process; the original failure is retained above.\n');
      continue;
    }
    const diagnostics = result.output.split(/\r?\n/).filter(line => /\berror\s*(?:[A-Z]+\d+)?\s*:/i.test(line));
    const detail = diagnostics.length ? [...new Set(diagnostics)].slice(0, 5).join('\n') : result.output.slice(-1800);
    throw new Error(`dotnet build exited with code ${result.code}${attempt ? ' after one native-compiler recovery attempt' : ''}. ${detail}`);
  }
}
