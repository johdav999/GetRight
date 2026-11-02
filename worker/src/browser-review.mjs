// Review starts only after a terminal result is acknowledged and tracing stops.
// It has no run lease/deadline and never changes the recorded acceptance.
export async function waitForBrowserReview(browser, { signal, onReady } = {}) {
  let finish;
  const finished = new Promise(resolve => { finish = resolve; });
  const contexts = new Set(), pages = new Set();
  const check = () => {
    if (!browser.isConnected() || browser.contexts().every(context => context.pages().length === 0)) finish();
  };
  const pageClosed = () => queueMicrotask(check);
  const watchPage = page => {
    if (pages.has(page)) return;
    pages.add(page);
    page.on('close', pageClosed);
  };
  const abort = () => { void browser.close().catch(() => {}); finish(); };
  browser.on('disconnected', finish);
  for (const context of browser.contexts()) {
    contexts.add(context);
    context.on('page', watchPage);
    context.on('close', pageClosed);
    for (const page of context.pages()) watchPage(page);
  }
  signal?.addEventListener('abort', abort, { once: true });
  try {
    if (signal?.aborted) abort();
    else { check(); await onReady?.(); }
    await finished;
  } finally {
    signal?.removeEventListener('abort', abort);
    browser.off('disconnected', finish);
    for (const context of contexts) { context.off('page', watchPage); context.off('close', pageClosed); }
    for (const page of pages) page.off('close', pageClosed);
  }
}
