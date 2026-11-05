import { setTimeout as delay } from 'node:timers/promises';

// Only pixels and bounded manual input cross the local dashboard. CDP remains
// on Playwright's owned pipe; no debugging port, cookies or auth are exposed.
export async function liveBrowser({ browser, context, page, run, lease, configuration }) {
  const origin = configuration.dashboardUrl, route = `/api/runs/${run.id}/browser`;
  const stop = new AbortController();
  const request = async (suffix, body) => {
    const response = await fetch(origin + route + suffix, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.any([stop.signal, AbortSignal.timeout(3000)]) });
    if (!response.ok) throw new Error(`Live browser connection returned HTTP ${response.status}.`);
    const text = await response.text(); return text ? JSON.parse(text) : null;
  };
  const viewport = page.viewportSize();
  const { token } = await request('/connect', { lease, width: viewport.width, height: viewport.height, supportsPausedInput: true });
  const cdp = await context.newCDPSession(page);
  let latest, review = false, lostAt, stopped = false, reduced = false;
  let transport = Promise.resolve(), acknowledgedBatch = 0, inputError;
  // Poll/input and step release share one lane. A step cannot start while
  // a previously dispatched manual command is still operating on the page.
  const serial = action => {
    const next = transport.then(action); transport = next.catch(() => {}); return next;
  };
  const frame = event => {
    void cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {});
    if (event.data.length <= 240000) latest = event.data;
    else if (!reduced) {
      reduced = true;
      void cdp.send('Page.stopScreencast').then(() => cdp.send('Page.startScreencast', { format: 'jpeg', quality: 30, maxWidth: 1024, maxHeight: 720, everyNthFrame: 1 })).catch(() => {});
    }
  };
  cdp.on('Page.screencastFrame', frame);
  try { await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 55, maxWidth: 1440, maxHeight: 1000, everyNthFrame: 1 }); }
  catch (error) { cdp.off('Page.screencastFrame', frame); await cdp.detach().catch(() => {}); await request('/end', { token }).catch(() => {}); throw error; }
  const input = async command => {
    if (command.type === 'click' || command.type === 'wheel') {
      const x = Math.max(0, Math.min(viewport.width - 1, command.x * viewport.width));
      const y = Math.max(0, Math.min(viewport.height - 1, command.y * viewport.height));
      await page.mouse.move(x, y);
      if (command.type === 'click') await page.mouse.click(x, y, { clickCount: command.clickCount });
      else await page.mouse.wheel(command.deltaX, command.deltaY);
    } else if (command.type === 'text') await page.keyboard.insertText(command.text);
    else if (command.type === 'key') {
      const keys = { ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight' };
      await page.keyboard.press([...(command.modifiers || []), keys[command.key] || command.key].join('+'));
    } else if (command.type === 'reload') await page.reload({ waitUntil: 'domcontentloaded', timeout: 5000 });
    else if (command.type === 'back') await page.goBack({ waitUntil: 'domcontentloaded', timeout: 5000 });
    else if (command.type === 'forward') await page.goForward({ waitUntil: 'domcontentloaded', timeout: 5000 });
  };
  const pumping = (async () => {
    while (!stopped && browser.isConnected() && !page.isClosed()) {
      try {
        const state = await serial(async () => {
         const state = await request('/poll', { token, phase: review ? 'review' : null, acknowledgedBatch }); lostAt = null;
         if ((state.inputBatch > acknowledgedBatch || (state.inputBatch === undefined && review)) && ['automating', 'review'].includes(state.phase)) {
          for (const command of state.commands) {
            if (stopped || page.isClosed() || configuration.signal?.aborted) break;
            try { await input(command); }
            catch (error) {
              if (!review) inputError = new Error(`Paused app interaction failed: ${String(error.message).slice(0, 200)}`);
              else console.error(`Manual review input could not complete: ${String(error.message).slice(0, 200)}`);
            }
          }
          acknowledgedBatch = state.inputBatch ?? acknowledgedBatch;
         }
         return state;
        });
        if (state.phase === 'closed' || state.phase === 'disconnected') { await browser.close(); break; }
        if (latest) { const jpeg = latest; latest = null; await request('/frame', { token, jpeg }); }
      } catch {
        if (stopped) break;
        lostAt ??= Date.now();
        if (Date.now() - lostAt > 15000) { await browser.close().catch(() => {}); break; }
      }
      await delay(200, undefined, { signal: stop.signal }).catch(() => {});
    }
  })();
  return {
    review() { review = true; },
    async beforeStep(step) {
      if (!run.stepByStep) return;
      const resume = configuration.pauseExecutionDeadline?.();
      const waiting = AbortSignal.any([...(configuration.signal ? [configuration.signal] : []), stop.signal,
        AbortSignal.timeout(configuration.stepPauseTimeoutMs ?? 15 * 60 * 1000)]);
      try {
        while (true) {
          waiting.throwIfAborted();
          if (!browser.isConnected() || page.isClosed()) throw new Error('The step browser was closed.');
          const state = await serial(async () => {
            if (inputError) throw inputError;
            return request('/step', { token, stepId: step.id, stage: 'waiting' });
          });
          if (state.execute) return;
          await delay(200, undefined, { signal: waiting });
        }
      } catch (error) {
        if (waiting.aborted && !configuration.signal?.aborted && !stop.signal.aborted)
          throw new Error('The paused step exceeded its review time limit. Start a new run to continue.');
        throw error;
      } finally { resume?.(); }
    },
    async afterStep(step) { if (run.stepByStep) await request('/step', { token, stepId: step.id, stage: 'passed' }); },
    async stop() {
      if (stopped) return;
      stopped = true; stop.abort(); await pumping;
      cdp.off('Page.screencastFrame', frame); await cdp.send('Page.stopScreencast').catch(() => {}); await cdp.detach().catch(() => {});
      // Use a fresh bounded signal after aborting the transport loop.
      await fetch(origin + route + '/end', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }),
        redirect: 'error', signal: AbortSignal.timeout(2000) }).catch(() => {});
    },
  };
}
