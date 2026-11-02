// Disposable demo and synthetic WriterApp checks; does not establish application acceptance.
import assert from 'node:assert/strict';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { api, repositoryRoot } from '../src/settings.mjs';
import { dashboardHost } from './dashboard-host.mjs';
import { createWriterAppContractHost } from './writerapp-contract-host.mjs';

const dataPath = path.join(repositoryRoot, '.local', `test-page-panel-${Date.now()}`);
const dashboard = await dashboardHost(dataPath);
let browser, writer;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const panel = page.getByRole('complementary', { name: 'Tested application', exact: true });
  const open = () => page.getByRole('button', { name: 'Open test page', exact: true }).first().click();
  await page.goto(dashboard.origin);
  await open();
  await expect(panel.locator('iframe')).toBeVisible();
  await expect(panel.locator('iframe').contentFrame().getByRole('heading')).toBeVisible();
  const box = await panel.boundingBox();
  assert.equal(box.x, 0); assert.equal(box.width, 750, 'left panel must occupy half the window');
  assert.equal((await page.locator('.shell').boundingBox()).x, 750);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  const entry = await panel.locator('iframe').getAttribute('src');
  assert.match(entry, /^\/uat-fixture.html\?fixture=uat-/);
  await page.getByRole('link', { name: 'Run history', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Run history', exact: true })).toBeVisible();
  await expect(panel.locator('iframe')).toHaveAttribute('src', entry);
  await page.screenshot({ path: path.join(dataPath, 'docked-desktop.png') });
  const popupPromise = page.waitForEvent('popup');
  await panel.getByRole('link', { name: 'Undock' }).click();
  const popup = await popupPromise; await popup.waitForLoadState();
  assert.equal(popup.url(), dashboard.origin + entry, 'undock retains the checked entry URL and fixture');
  await expect(panel).toHaveCount(0); await popup.close();
  assert.equal((await page.locator('.shell').boundingBox()).width, 1500);
  assert.equal((await api(dashboard.origin, '/api/runs')).length, 0, 'manual opening creates no run');

  writer = await createWriterAppContractHost();
  await api(dashboard.origin, '/api/applications/writerapp/profile', {
    applicationId: 'writerapp', baseUrl: writer.origin, expectedBuildVersion: writer.state.version,
    expectedUserId: writer.state.userId, isolatedDataConfirmed: true,
  });
  await page.goto(dashboard.origin);
  await page.getByRole('button', { name: 'WriterApp', exact: true }).click();
  await open();
  await expect(panel.locator('iframe').contentFrame().getByRole('heading', { name: 'Documents', exact: true })).toBeVisible();
  assert.equal(writer.state.creates, 0);
  await panel.getByRole('button', { name: 'Close tested application panel' }).click();
  writer.state.version = 'wrong-build';
  await open();
  await expect(panel.getByRole('alert')).toContainText('running build does not match');
  await expect(panel.locator('iframe')).toHaveCount(0);
  await expect(panel.getByRole('link', { name: 'Undock' })).toHaveCount(0);
  await panel.getByRole('button', { name: 'Close tested application panel' }).click();
  assert.equal((await api(dashboard.origin, '/api/runs')).length, 0);
  writer.state.version = '0.1.100.42';

  // Historical run review uses the same panel and does not change acceptance.
  const run = await api(dashboard.origin, '/api/runs', { testId: 'getright-save-note' });
  await page.goto(`${dashboard.origin}/runs/${run.id}`);
  await open(); await expect(panel.locator('iframe')).toBeVisible();
  assert.equal((await api(dashboard.origin, `/api/runs/${run.id}`)).acceptance, 'pending');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(panel).toBeVisible();
  assert.equal((await panel.boundingBox()).width, 390);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: path.join(dataPath, 'docked-mobile.png'), fullPage: true });
  await panel.getByRole('button', { name: 'Close tested application panel' }).click();
  await expect(panel).toHaveCount(0);
  assert.deepEqual(errors, []);
  console.log(`PASS: half-width left panel, real iframe interaction, navigation retention, undock URL/fixture, close, cross-origin synthetic app, preflight failure, run-review pending acceptance and mobile layout.\nLocal evidence: ${dataPath}`);
} finally { await browser?.close(); await dashboard.stop(); await writer?.close(); }
