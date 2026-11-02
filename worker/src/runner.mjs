import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { api } from './settings.mjs';
import { writerAppAdapter } from './writerapp.mjs';
import { virtualCompanyAdapter } from './virtual-company.mjs';

// Adapter IDs are allowlisted in source. The API cannot submit executable code,
// shell commands or arbitrary navigation targets to this local worker.
export async function executeRun(claim, configuration) {
  configuration.signal?.throwIfAborted();
  const { run, lease } = claim;
  if (!/^[a-f0-9]{32}$/.test(run.id) || run.fixtureId !== `uat-${run.id}`) throw new Error('Invalid run identity.');
  const directory = path.join(configuration.dataPath, 'evidence', run.id);
  await mkdir(directory, { recursive: true });
  const result = { lease, status: 'failed', buildVersion: null, baseUrl: configuration.dashboardUrl, steps: [], trace: null, error: null };
  let browser, context, currentStep, adapter;
  const abortBrowser = () => { void browser?.close().catch(() => {}); };
  const pageErrors = [];
  try {
    const demo = run.testSnapshot.adapter === 'getright-save-note' && run.applicationId === 'getright';
    const writer = run.testSnapshot.adapter === 'writerapp-create-save' && run.applicationId === 'writerapp';
    const company = run.testSnapshot.adapter === 'virtual-company-test-setup' && run.applicationId === 'virtual-company';
    if (!demo && !writer && !company) throw new Error('No registered adapter for this test.');
    if (demo) {
      const health = await api(configuration.dashboardUrl, '/api/health');
      if (health.name !== 'Getright' || !health.version) throw new Error('The running application did not identify its build.');
      result.buildVersion = health.version;
    }
    browser = await chromium.launch({ headless: configuration.headless, slowMo: configuration.headless ? 0 : 200 });
    configuration.signal?.addEventListener('abort', abortBrowser, { once: true });
    configuration.signal?.throwIfAborted();
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    context.setDefaultTimeout(15_000);
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    const page = await context.newPage();
    page.on('pageerror', error => pageErrors.push(error.message));
    const title = `UAT note ${run.id.slice(0, 8)}`;
    const body = `Saved fixture content for ${run.fixtureId}.`;
    let actions = {
      open: async () => {
        await page.goto(`${configuration.dashboardUrl}/uat-fixture.html?fixture=${run.fixtureId}`);
        await expect(page.getByRole('heading', { name: 'Your working note' })).toBeVisible();
        await expect(page.getByLabel('Title', { exact: true })).toHaveValue('');
      },
      edit: async () => {
        await page.getByLabel('Title', { exact: true }).fill(title);
        await page.getByLabel('Note', { exact: true }).fill(body);
      },
      save: async () => {
        await page.getByRole('button', { name: 'Save note' }).click();
        await expect(page.getByRole('status')).toHaveText('Note saved successfully.');
      },
      reopen: async () => {
        await page.reload();
        await expect(page.getByLabel('Title', { exact: true })).toHaveValue(title);
        await expect(page.getByLabel('Note', { exact: true })).toHaveValue(body);
      },
    };
    if (writer || company) {
      adapter = (company ? virtualCompanyAdapter : writerAppAdapter)(page, context, run);
      result.baseUrl = adapter.origin;
      result.buildVersion = await adapter.verify();
      result.identity = adapter.identity;
      actions = adapter.actions;
      // Target UAT cannot navigate to an external sign-in/provider by accident.
      await context.route('**/*', route => new URL(route.request().url()).origin === adapter.origin ? route.continue() : route.abort('blockedbyclient'));
    }
    for (const step of run.testSnapshot.steps) {
      configuration.signal?.throwIfAborted();
      currentStep = step.id;
      if (!Object.hasOwn(actions, step.id)) throw new Error(`Unregistered adapter step: ${step.id}`);
      await actions[step.id]();
      if (pageErrors.length) throw new Error(pageErrors.join('\n'));
      const screenshot = `${run.id}/${step.id}.png`;
      await page.screenshot({ path: path.join(directory, `${step.id}.png`), fullPage: true });
      result.steps.push({ stepId: step.id, status: 'passed', screenshot, error: null });
      currentStep = null;
    }
    const finalVersion = (writer || company) ? await adapter.verify() : (await api(configuration.dashboardUrl, '/api/health')).version;
    if (finalVersion !== result.buildVersion) throw new Error('The application build changed during this run.');
    result.status = 'passed';
  } catch (error) {
    result.error = error.message;
    if (currentStep) {
      let screenshot = null;
      try {
        const page = context?.pages()[0];
        if (page) { await page.screenshot({ path: path.join(directory, `${currentStep}-failed.png`), fullPage: true }); screenshot = `${run.id}/${currentStep}-failed.png`; }
      } catch { /* Preserve the original failure if the browser has already closed. */ }
      result.steps.push({ stepId: currentStep, status: 'failed', screenshot, error: error.message });
    }
  } finally {
    if (context) {
      try { await context.tracing.stop({ path: path.join(directory, 'trace.zip') }); result.trace = `${run.id}/trace.zip`; }
      catch (error) { result.status = 'failed'; result.error ??= `Trace capture failed: ${error.message}`; }
    }
    await browser?.close().catch(() => {});
    configuration.signal?.removeEventListener('abort', abortBrowser);
  }
  configuration.signal?.throwIfAborted();
  return api(configuration.dashboardUrl, `/api/runs/${run.id}/complete`, result);
}
