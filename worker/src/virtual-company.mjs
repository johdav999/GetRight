import { expect } from '@playwright/test';
import { localUrl } from './settings.mjs';

export function virtualCompanyAdapter(page, context, run) {
  const target = run.target;
  if (!target || target.applicationId !== 'virtual-company' || !target.isolatedDataConfirmed || target.expectedRole !== 'owner') throw new Error('An isolated Virtual Company owner profile is required.');
  const origin = localUrl(target.baseUrl);
  const identity = { userId: target.expectedUserId, documentId: null, companyId: null,
    isolationCompanyId: target.expectedCompanyId, evidenceKind: 'live-application', roles: ['owner'] };
  const name = `Getright ${run.fixtureId}`, recipient = `${run.fixtureId}@example.invalid`;
  let reference;
  const read = async (suffix, options) => {
    const response = await context.request.get(`${origin}${suffix}`, options);
    if (!response.ok()) throw new Error(`Virtual Company read failed (${response.status()}): ${suffix}`);
    return response.json();
  };
  const verify = async () => {
    const runtime = await read('/_getright/runtime');
    if (runtime.version !== target.expectedBuildVersion || runtime.userId !== target.expectedUserId ||
        runtime.companyId !== target.expectedCompanyId || runtime.role !== target.expectedRole || runtime.isolated !== true)
      throw new Error('Virtual Company build, account, role, company or isolation does not match the frozen target.');
    const user = await read('/api/auth/me');
    if (user.user?.id !== target.expectedUserId || !user.memberships?.some(m => m.companyId === target.expectedCompanyId && m.membershipRole === 'owner' && m.status === 'active'))
      throw new Error('The actual Virtual Company API owner does not match the runtime receipt.');
    return runtime.version;
  };
  const policy = () => read(`/api/test-companies/${identity.companyId}/policy`, { headers: { 'X-Company-Id': identity.companyId } });
  const actions = {
    workflow: async () => {
      // Immutable ordinary-company profile is the isolation sentinel.
      reference = await read(`/api/companies/${target.expectedCompanyId}/access`, { headers: { 'X-Company-Id': target.expectedCompanyId } });
      await page.goto(`${origin}/test-companies/new`);
      await expect(page.locator('#test-name')).toBeEnabled();
      await expect(page.locator('.test-create button[type=submit]')).toBeEnabled();
    },
    create: async () => {
      await page.locator('#test-name').fill(name);
      await page.locator('.test-create input[type=checkbox]').check();
      await page.locator('.test-create button[type=submit]').click();
      await page.waitForURL('**/settings/test-company?companyId=*');
      await expect(page.locator('#test-name')).toBeEnabled();
      identity.companyId = new URL(page.url()).searchParams.get('companyId');
      if (!/^[a-f0-9-]{36}$/.test(identity.companyId || '') || identity.companyId === target.expectedCompanyId) throw new Error('The created company must have its own identity.');
      await expect(page.locator('.test-policy h2')).toContainText(name);
      const profile = await read(`/api/test-companies/${identity.companyId}/profile`, { headers: { 'X-Company-Id': identity.companyId } });
      if (profile.companyId !== identity.companyId || profile.companyName !== name || !profile.isTestCompany || !profile.externalActionsBlocked) throw new Error('The company was not created as an isolated test company.');
      const initial = await policy();
      if (initial.permittedActions.length || initial.approvedRecipients.length || initial.approvedConnections.length) throw new Error('The new company inherited permissions.');
    },
    permissions: async () => {
      const prepared = await context.request.post(`${origin}/_getright/prepare-company?companyId=${identity.companyId}`);
      if (!prepared.ok()) throw new Error('Could not prepare the disconnected company fixture.');
      await page.reload();
      await expect(page.locator('#test-name')).toBeEnabled();
      await expect(page.locator('#test-recipients')).toBeEnabled();
      await page.locator('.test-policy form input[type=checkbox]').nth(1).check();
      await page.locator('#test-recipients').fill(recipient);
      await page.locator('.test-policy label').filter({ hasText: 'getright-sender@example.invalid' }).locator('input').check();
      await page.locator('.test-policy button[type=submit]').click();
      await expect(page.getByRole('status').filter({ hasText: 'Permissions saved.' })).toBeVisible();
      await expect.poll(async () => (await policy()).permittedActions).toEqual(['email.draft']);
      const saved = await policy();
      expect(saved.approvedRecipients).toEqual([recipient]); expect(saved.approvedConnections).toHaveLength(1);
      expect(saved.approvedConnections[0].senderAddress).toBe('getright-sender@example.invalid');
    },
    reopen: async () => {
      await page.reload();
      await expect(page.locator('#test-name')).toBeEnabled();
      await expect(page.locator('.test-policy h2')).toContainText(name);
      await expect(page.locator('.test-policy form input[type=checkbox]').nth(0)).not.toBeChecked();
      await expect(page.locator('.test-policy form input[type=checkbox]').nth(1)).toBeChecked();
      await expect(page.locator('#test-recipients')).toHaveValue(recipient);
      const persisted = await policy(); expect(persisted.permittedActions).toEqual(['email.draft']); expect(persisted.approvedRecipients).toEqual([recipient]);
      const user = await read('/api/auth/me');
      expect(user.memberships.some(m => m.companyId === identity.companyId && m.membershipRole === 'owner' && m.isTestCompany)).toBe(true);
      const employee = await read('/api/auth/me', { headers: { 'X-Dev-Auth-Subject': 'getright-employee' } });
      expect(employee.memberships.some(m => m.companyId === target.expectedCompanyId && m.membershipRole === 'employee')).toBe(true);
      expect(employee.memberships.some(m => m.companyId === identity.companyId && m.membershipRole === 'employee')).toBe(true);
      const denied = await context.request.get(`${origin}/api/test-companies/${identity.companyId}/policy`, { headers: { 'X-Dev-Auth-Subject': 'getright-employee', 'X-Company-Id': identity.companyId } });
      expect([403, 404]).toContain(denied.status());
      const deniedWrite = await context.request.put(`${origin}/api/test-companies/${identity.companyId}/policy`, { headers: { 'X-Dev-Auth-Subject': 'getright-employee', 'X-Company-Id': identity.companyId }, data: { expectedRevision: persisted.revision, permittedActions: ['email.send'], approvedRecipients: [], approvedConnectionIds: [] } });
      expect([403, 404]).toContain(deniedWrite.status());
      const outsider = await context.request.get(`${origin}/api/test-companies/${identity.companyId}/policy`, { headers: { 'X-Dev-Auth-Subject': 'getright-outsider', 'X-Company-Id': identity.companyId } });
      expect([403, 404]).toContain(outsider.status());
      expect(await policy()).toEqual(persisted);
      expect(await read(`/api/companies/${target.expectedCompanyId}/access`, { headers: { 'X-Company-Id': target.expectedCompanyId } })).toEqual(reference);
    },
  };
  return { origin, identity, verify, actions };
}
