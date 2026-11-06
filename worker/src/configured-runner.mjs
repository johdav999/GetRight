import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { api, localUrl } from './settings.mjs';
import { registeredRuntimeAdapter, runtimeLifecycle } from './runtime-configuration.mjs';
import { configuredActions } from './configured-workflow.mjs';
import { supervise } from './supervision.mjs';
import { liveBrowser } from './live-browser.mjs';
import { waitForBrowserReview } from './browser-review.mjs';

async function restrictBrowser(context, origin, dashboardFixture) {
  await context.routeWebSocket('**/*', socket => {
    if (!dashboardFixture && new URL(socket.url()).origin.replace(/^ws:/, 'http:') === origin) socket.connectToServer();
    else void socket.close();
  });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin || (dashboardFixture && (route.request().method() !== 'GET' ||
        ![dashboardFixture, '/uat-fixture.js', '/app.css'].includes(url.pathname)))) {
      await route.abort('blockedbyclient');
      return;
    }
    // An intercepted request can redirect outside the routing callback.
    // Fetch one hop and refuse redirects before Chromium can follow them.
    let response;
    try {
      response = await route.fetch({ maxRedirects: 0, timeout: 10000 });
      if (response.status() >= 300 && response.status() < 400 && response.headers().location) await route.abort('blockedbyclient');
      else await route.fulfill({ response });
    } catch { await route.abort('failed').catch(() => {}); }
    finally { await response?.dispose().catch(() => {}); }
  });
}

async function screenshot(page, directory, runId, step, observations, failed = false) {
  if (page.url() === 'about:blank' && observations.length) {
    // Evidence for API-only steps includes statuses and paths, never bodies,
    // headers or cookies. Paths use the workflow's restricted alphabet.
    const lines = observations.map(o => `${o.method} ${o.path.replaceAll('&', '&amp;')} → HTTP ${o.status}`).join('\n');
    await page.setContent(`<title>API step evidence</title><h1>API step evidence</h1><pre>${lines}</pre>`, { timeout: 2000 });
  }
  const name = `${step.stepId}${failed ? '-failed' : ''}.png`;
  await page.screenshot({ path: path.join(directory, name), fullPage: true, timeout: 5000 });
  return `${runId}/${name}`;
}

export async function executeConfiguredRun(claim, configuration, plan) {
  const { run, lease } = claim;
  const route = `/api/runs/${run.id}`;
  const result = { lease, status: 'failed', buildVersion: null, baseUrl: null, steps: [], trace: null, error: null };
  const supervision = supervise({ configuration, heartbeat: `${route}/heartbeat`, lease, timeoutMs: configuration.runTimeoutMs ?? 180000, cancellation: true });
  const signal = supervision.signal;
  const directory = path.join(configuration.dataPath, 'evidence', run.id);
  let browser, context, page, dock, lifecycle, step, observations, tracing;
  const abortBrowser = () => { void browser?.close().catch(() => {}); };
  try {
    await supervision.ready;
    signal.throwIfAborted();
    const { manifest, dashboardBuild } = run.configuration;
    const dashboardFixture = dashboardBuild != null;
    const origin = localUrl(dashboardFixture ? configuration.dashboardUrl : run.target.baseUrl);
    if (!dashboardFixture && new URL(origin).port === new URL(configuration.dashboardUrl).port) throw new Error('The configured target must be separate from the control room.');
    result.baseUrl = origin;
    await mkdir(directory, { recursive: true });
    if (!dashboardFixture) lifecycle = runtimeLifecycle(claim, { ...configuration, signal });
    browser = await chromium.launch({ headless: run.docked || configuration.headless, slowMo: run.docked || !configuration.headless ? 200 : 0,
      timeout: Math.min(15000, configuration.runTimeoutMs ?? 15000) });
    signal.addEventListener('abort', abortBrowser, { once: true });
    signal.throwIfAborted();
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
    await restrictBrowser(context, origin, dashboardFixture ? manifest.entryPath : null);
    page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    const targetRequest = {
      get: (url, options) => context.request.get(url, { ...options, maxRedirects: 0, timeout: 3000 }),
      post: (url, options) => context.request.post(url, { ...options, maxRedirects: 0, timeout: 3000 }),
      put: (url, options) => context.request.put(url, { ...options, maxRedirects: 0, timeout: 3000 }),
    };
    const adapter = registeredRuntimeAdapter(manifest.fixtureAdapter)?.(page, { request: targetRequest }, run);
    result.buildVersion = dashboardFixture ? dashboardBuild : adapter ? await adapter.verify() : run.target.expectedBuildVersion;
    if (run.target) result.identity = adapter?.identity ?? { userId: run.target.expectedUserId, evidenceKind: 'live-application', roles: [] };
    await lifecycle?.setup();
    signal.throwIfAborted();
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    tracing = true;
    if (run.docked) dock = await liveBrowser({ browser, context, page, run, lease,
      configuration: { ...configuration, signal, pauseExecutionDeadline: supervision.pauseDeadline } });
    const { execute, resources } = configuredActions({ page, origin, run, lifecycle, signal, adapter });
    for (const [index, definition] of plan.steps.entries()) {
      step = definition;
      observations = [];
      await dock?.beforeStep(run.testSnapshot.steps[index]);
      for (const action of step.actions) {
        await execute(action, observations, step.stepId);
        signal.throwIfAborted();
        if (pageErrors.length) throw new Error('The tested page reported an unhandled script error.');
        if (page.url() !== 'about:blank' && new URL(page.url()).origin !== origin) throw new Error('The workflow left the isolated application origin.');
      }
      const shot = await screenshot(page, directory, run.id, step, observations);
      await dock?.afterStep(run.testSnapshot.steps[index]);
      result.steps.push({ stepId: step.stepId, status: 'passed', screenshot: shot, error: null, apiObservations: observations });
      step = null;
    }
    if ((dashboardFixture && (await api(configuration.dashboardUrl, '/api/health')).version !== dashboardBuild) ||
        (adapter && await adapter.verify() !== result.buildVersion)) throw new Error('The application build changed during execution.');
    if (result.identity) result.identity = { ...result.identity, resources,
      documentId: resources.find(resource => resource.kind === 'document')?.id ?? null,
      companyId: resources.find(resource => resource.kind === 'company')?.id ?? null };
    result.status = 'passed';
  } catch (error) {
    result.error = error.message;
    if (step) {
      const shot = await screenshot(page, directory, run.id, step, observations, true).catch(() => null);
      result.steps.push({ stepId: step.stepId, status: 'failed', screenshot: shot, error: error.message, apiObservations: observations });
    }
  } finally {
    if (tracing) {
      try { await context.tracing.stop({ path: path.join(directory, 'trace.zip') }); result.trace = `${run.id}/trace.zip`; }
      catch { result.status = 'failed'; result.error ??= 'Trace capture failed.'; }
    }
    try { if (lifecycle) Object.assign(result, await lifecycle.finish(result)); }
    catch { result.status = 'failed'; result.error ??= 'Runtime lifecycle reporting failed.'; }
    finally { await lifecycle?.close(); await supervision.stop(); }
    signal.removeEventListener('abort', abortBrowser);
  }
  if (signal.aborted) {
    result.status = supervision.cancelled ? 'cancelled' : supervision.timedOut ? 'failed' : 'interrupted';
    result.error = String(signal.reason?.message || 'The run was interrupted.');
  }
  try {
    const completed = await api(configuration.dashboardUrl, `${route}/complete`, result).catch(async error => {
      const stored = await api(configuration.dashboardUrl, route).catch(() => null);
      if (stored && !['queued', 'running'].includes(stored.status)) return stored;
      throw error;
    });
    if (page && !page.isClosed() && !signal.aborted && !configuration.signal?.aborted && configuration.keepBrowserOpen !== false &&
        (run.docked || !configuration.headless) && ['passed', 'failed'].includes(completed.status)) {
      dock?.review();
      await waitForBrowserReview(browser, { signal: configuration.signal, onReady: () => configuration.onReviewReady?.({ browser, run: completed }) });
    }
    return completed;
  } finally { await dock?.stop(); await browser?.close().catch(() => {}); }
}
