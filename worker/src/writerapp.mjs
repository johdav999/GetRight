import { expect } from '@playwright/test';
import { localUrl } from './settings.mjs';

// This adapter uses the actual WriterApp UI and backend. Tests with a mock host
// verify this contract, but are explicitly not evidence of live WriterApp UAT.
export function writerAppAdapter(page, context, run) {
  const target = run.target;
  if (!target || target.applicationId !== 'writerapp' || !target.isolatedDataConfirmed ||
      !target.expectedBuildVersion || !target.expectedUserId) throw new Error('WriterApp needs a frozen, isolated target profile.');
  const origin = localUrl(target.baseUrl);
  const body = `Getright persistence verification for ${run.fixtureId}.`;
  const identity = { userId: '', documentId: null, evidenceKind: 'live-application', roles: [] };
  let sectionId, initialTitle;
  const editor = () => page.locator('.editor-surface .ProseMirror[contenteditable="true"]').first();
  async function get(route) {
    const response = await context.request.get(`${origin}${route}`, { maxRedirects: 0, timeout: 10_000 });
    if (!response.ok()) throw new Error(`WriterApp returned ${response.status()} while verifying ${route.split('/').slice(0, 3).join('/')}.`);
    return response.json();
  }
  async function verify() {
    const version = await get('/api/app/version');
    if (version.version !== target.expectedBuildVersion) throw new Error('The running WriterApp build does not match this run. No further actions will be performed.');
    const auth = await get('/api/auth/me');
    if (auth.isAuthenticated !== true || auth.userId !== target.expectedUserId) throw new Error('WriterApp is not using the dedicated UAT account for this run.');
    identity.userId = auth.userId;
    identity.roles = Array.isArray(auth.roles) ? auth.roles.filter(role => typeof role === 'string') : [];
    return version.version;
  }
  return {
    origin, identity, verify,
    actions: {
      library: async () => {
        await verify();
        // Account provisioning is fixture setup, not part of the document workflow.
        // Complete first-run onboarding only after verifying the isolated account.
        const onboarding = await context.request.post(`${origin}/api/onboarding/complete`, { maxRedirects: 0 });
        if (!onboarding.ok()) throw new Error(`Could not prepare the isolated WriterApp account (${onboarding.status()}).`);
        await page.goto(`${origin}/app/documents`);
        const documentsTab = page.locator('.landing-tabs').getByRole('button', { name: 'Documents', exact: true });
        await expect(page.locator('.prosa-library')).toBeVisible({ timeout: 30_000 });
        const create = page.getByRole('button', { name: 'Create new document', exact: true }).first();
        // The client can replace its initial Projects view when local config
        // arrives. Retry only this idempotent navigation, never document creation.
        await expect(async () => {
          if (!(await create.isVisible()) && await documentsTab.isVisible()) await documentsTab.click({ timeout: 1000 });
          await expect(create).toBeVisible({ timeout: 1000 });
        }).toPass({ timeout: 30_000, intervals: [100, 250, 500] });
      },
      create: async () => {
        await verify();
        const responsePromise = page.waitForResponse(response => response.url() === `${origin}/api/documents` && response.request().method() === 'POST');
        await page.getByRole('button', { name: 'Create new document', exact: true }).first().click();
        const response = await responsePromise;
        if (!response.ok()) throw new Error(`WriterApp could not create the isolated document (${response.status()}).`);
        const created = await response.json();
        if (!/^[a-f0-9-]{36}$/i.test(created.document?.id ?? '') || !/^[a-f0-9-]{36}$/i.test(created.defaultSectionId ?? '')) throw new Error('WriterApp did not return the created document and section identities.');
        identity.documentId = created.document.id; sectionId = created.defaultSectionId; initialTitle = created.document.title;
        await expect(editor()).toBeVisible();
        await editor().fill(body);
      },
      save: async () => {
        await page.getByRole('button', { name: 'Document actions', exact: true }).click();
        await page.getByRole('group', { name: 'Document actions', exact: true }).getByRole('button', { name: 'Save now', exact: true }).click();
        await expect.poll(async () => JSON.stringify(await get(`/api/sections/${sectionId}/pages`)), { timeout: 30_000 }).toContain(body);
        await expect(editor()).toContainText(body);
      },
      reopen: async () => {
        await page.reload();
        await expect(editor()).toContainText(body, { timeout: 30_000 });
        const document = await get(`/api/documents/${identity.documentId}`);
        expect(document.title).toBe(initialTitle);
        expect(JSON.stringify(await get(`/api/sections/${sectionId}/pages`))).toContain(body);
        await verify();
      },
    },
  };
}
