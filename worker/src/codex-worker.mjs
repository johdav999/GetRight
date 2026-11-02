import { Codex } from '@openai/codex-sdk';
import { cleanEnvironment } from './processes.mjs';

export async function implementWithCodex({ worktree, prompt, screenshot, signal, report, log, model }) {
  const codex = new Codex({ env: cleanEnvironment(process.env, true), configOverrides: ['mcp_servers={}'] });
  const thread = codex.startThread({ workingDirectory: worktree, sandboxMode: 'workspace-write', approvalPolicy: 'never',
    networkAccessEnabled: false, webSearchMode: 'disabled', additionalDirectories: [], ...(model ? { model } : {}) });
  const input = [{ type: 'text', text: prompt }];
  if (screenshot) input.push({ type: 'local_image', path: screenshot });
  const { events } = await thread.runStreamed(input, { signal });
  let completed = false, summary = '';
  for await (const event of events) {
    log(`${JSON.stringify(event)}\n`);
    if (event.type === 'thread.started') await report('Codex thread started.', { threadId: event.thread_id });
    if (event.type === 'item.completed') {
      const item = event.item;
      if (item.type === 'agent_message') { summary = item.text.slice(0, 8000); await report(item.text.slice(0, 3800)); }
      if (item.type === 'file_change') await report(`Codex ${item.status}: ${item.changes.map(change => `${change.kind} ${change.path}`).join(', ')}`.slice(0, 3800));
      if (item.type === 'command_execution') await report(`Codex command finished (exit ${item.exit_code ?? 'unknown'}). Details are in the local Codex log.`);
    }
    if (event.type === 'turn.completed') completed = true;
    if (event.type === 'error' || event.type === 'turn.failed') throw new Error(event.message ?? event.error?.message ?? 'Codex turn failed.');
  }
  if (!completed) throw new Error('Codex ended without a completed turn.');
  return { threadId: thread.id, summary };
}
