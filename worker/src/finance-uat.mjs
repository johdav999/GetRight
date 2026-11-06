import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const prefix = 'virtual-company-finance-';
const cases = {
  'cash-source': ['ask-en', 'ask-sv', 'open-source'],
  'invoice-ambiguity': ['ask-ambiguous', 'clarify'],
  'invoice-isolation': ['read-own', 'request-foreign', 'verify-isolation'],
  'category-recommendation': ['recommend', 'verify-unchanged'],
  'approval-once': ['request', 'approve', 'replay'],
  'approval-stale': ['request', 'change-target', 'attempt-approval'],
};
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const cashTime = Date.parse('2026-10-15T10:00:00Z');

export function financeStep(testId, stepId) {
  const scenario = testId.slice(prefix.length);
  return testId.startsWith(prefix) && Object.hasOwn(cases, scenario) && cases[scenario].includes(stepId);
}

export function financeActions({ page, origin, run, signal, resources }) {
  const scenario = run.testId.slice(prefix.length);
  assert.match(run.id, /^[0-9a-f]{32}$/);
  const fixturePath = `/_getright/finance/${run.id}`;
  let fixture, baseline, english, swedish, pending, applied, decision;
  let evidence;

  async function show(message) {
    evidence.push(message);
    await page.setContent('<main><h1>Finance Agent API evidence</h1><pre></pre></main>', { timeout: 2000 });
    await page.locator('pre').evaluate((node, value) => { node.textContent = value; }, evidence.join('\n'));
  }

  async function request(method, path, { subject, data, statuses = [200] } = {}) {
    signal.throwIfAborted();
    const url = new URL(path, origin);
    assert.equal(url.origin, origin);
    assert(!url.username && !url.password);
    const response = await page.request.fetch(url.href, {
      method, data, maxRedirects: 0, timeout: 10000,
      headers: subject ? { 'X-Dev-Auth-Subject': subject } : undefined
    });
    try {
      await show(`${method} ${path} → HTTP ${response.status()}`);
      assert(statuses.includes(response.status()), `Unexpected status ${response.status()} for ${path}.`);
      if (response.status() === 204) return null;
      return await response.json();
    } finally { await response.dispose(); }
  }

  const state = () => request('GET', `${fixturePath}/state`);
  const companyApi = () => `/api/companies/${fixture.companyId}`;
  const agentApi = () => `${companyApi()}/agents/${fixture.agentId}`;
  const toolPlans = () => `${agentApi()}/finance/tool-plans`;
  const invoiceReference = value => [{ type: 'invoice', value }];
  const ask = (userRequest, fields = {}) => request('POST', `${toolPlans()}/execute`, {
    subject: fixture.requesterSubject, data: { userRequest, idempotencyKey: randomUUID(), ...fields }
  });
  const transactionContext = () => [{ companyId: fixture.companyId, sourceId: `finance_transaction:${fixture.transactionId}`,
    sourceType: 'transaction', title: 'Cloud software subscription', content: 'Uncategorized transaction.',
    recordId: fixture.transactionId, recordVersion: baseline.createdUtc, updatedUtc: baseline.createdUtc }];
  const approvalApi = () => `${companyApi()}/approvals/${pending.approvalRequestId}`;
  const readApproval = () => request('GET', approvalApi(), { subject: fixture.approverSubject });

  async function setup() {
    fixture = await request('POST', fixturePath, { statuses: [201] });
    assert.equal(fixture.runId.replaceAll('-', ''), run.id);
    for (const key of ['companyId', 'foreignCompanyId', 'agentId', 'requesterId', 'approverId',
      'cashAccountId', 'transactionId', 'invoiceId', 'alternateInvoiceId', 'foreignInvoiceId'])
      assert.match(fixture[key], uuid);
    assert.notEqual(fixture.companyId, run.target.expectedCompanyId);
    assert.notEqual(fixture.companyId, fixture.foreignCompanyId);
    assert.notEqual(fixture.requesterId, fixture.approverId);
    assert.equal(fixture.requesterSubject, `getright-finance-requester-${run.id}`);
    assert.equal(fixture.approverSubject, `getright-finance-approver-${run.id}`);
    resources.push({ kind: 'company', id: fixture.companyId, scopeId: run.target.expectedCompanyId });
    for (const [subject, id, role] of [
      [fixture.requesterSubject, fixture.requesterId, 'manager'],
      [fixture.approverSubject, fixture.approverId, 'owner']
    ]) {
      const actor = await request('GET', '/api/auth/me', { subject });
      assert.equal(actor.user.id, id);
      assert(actor.memberships.some(item => item.companyId === fixture.companyId && item.membershipRole === role));
      if (role === 'manager') assert(!actor.memberships.some(item => item.companyId === fixture.foreignCompanyId));
    }
    baseline = await state();
  }

  async function cash(prompt, amountText) {
    const result = await ask(prompt);
    await show(result.answer?.summary ?? `${result.reasonCode}: ${result.safeExplanation}`);
    assert.equal(result.state, 'completed', result.safeExplanation);
    const [step] = result.steps;
    assert.equal(step.toolName, 'get_cash_balance');
    const balance = step.validatedOutput?.data?.cashBalance;
    assert.equal(balance?.companyId, fixture.companyId);
    assert.equal(balance.amount, 12345.67);
    assert.equal(balance.currency, 'SEK');
    assert.equal(Date.parse(balance.asOfUtc), cashTime);
    assert.match(JSON.stringify(result.answer), amountText);
    assert(result.answer.sources?.some(source => source.sourceType === 'validated_finance_tool_result'),
      'The answer did not cite its validated tool result.');
    return result.answer;
  }

  async function invoice(value) {
    const result = await ask(`What is the total for this invoice reference?`, { references: invoiceReference(value) });
    await show(`${result.reasonCode}: ${result.safeExplanation}`);
    return result;
  }

  async function ownInvoice(value) {
    const result = await invoice(value);
    assert.equal(result.state, 'completed', result.safeExplanation);
    const rows = result.steps[0]?.validatedOutput?.data?.invoices;
    assert.equal(rows?.length, 1, 'The answer must resolve exactly one invoice.');
    assert.equal(rows[0].id ?? rows[0].invoiceId, fixture.invoiceId);
    assert.equal(rows[0].amount ?? rows[0].totalAmount, 1250);
    assert(result.answer?.sources?.some(source => source.link && source.link.includes(fixture.invoiceId)),
      'The answer did not link to the selected invoice.');
  }

  async function requestApproval() {
    assert.equal(baseline.category, 'uncategorized');
    const preview = await request('POST', `${toolPlans()}/preview-mutation`, {
      subject: fixture.requesterSubject,
      data: { userRequest: 'Please categorize the cloud software subscription as Software.', context: transactionContext() }
    });
    await show(`${preview.reasonCode}: ${preview.safeExplanation}`);
    assert.equal(preview.state, 'approval_required', preview.safeExplanation);
    assert.equal(preview.steps.length, 1);
    const [step] = preview.steps;
    assert.equal(step.toolName, 'categorize_transaction');
    assert.equal(step.target.entityId, fixture.transactionId);
    assert.equal(step.proposedChange.category, 'software');
    assert.deepEqual(await state(), baseline);
    assert(step.confirmationToken, 'The exact mutation preview did not return a confirmation token.');
    pending = await request('POST', `${toolPlans()}/confirm-mutation`, {
      subject: fixture.requesterSubject, data: { confirmationToken: step.confirmationToken }
    });
    assert.equal(pending.state, 'approval_required_after_confirmation', pending.safeExplanation);
    assert.match(pending.approvalRequestId ?? '', uuid, 'The execution did not request an approval.');
    const current = await state();
    assert.equal(current.category, 'uncategorized');
    assert.equal(current.createdUtc, baseline.createdUtc);
    assert.equal(current.approvals.length, 1);
    assert.equal(current.approvals[0].id, pending.approvalRequestId);
    assert.equal(current.approvals[0].targetEntityId, pending.executionId);
    assert.equal(current.approvals[0].status, 'Pending');
  }

  async function approve() {
    const approval = await readApproval();
    assert.match(approval.currentStep?.id ?? '', uuid);
    decision = { decision: 'approve', stepId: approval.currentStep.id, clientRequestId: randomUUID() };
    await deliverDecision();
    return state();
  }

  const deliverDecision = () => request('POST', `${approvalApi()}/decisions`, {
    subject: fixture.approverSubject, data: decision
  });

  return async function execute(step) {
    assert(financeStep(run.testId, step), 'Unknown Finance Agent UAT step.');
    evidence = [run.testSnapshot.title, `Fixture ${run.fixtureId}`, `Step ${step}`];
    if (!fixture) await setup();
    switch (step) {
      case 'ask-en':
        english = await cash('What is the current cash balance and its source?', /12,345\.67/);
        break;
      case 'ask-sv':
        swedish = await cash('Vad är aktuellt kassasaldo och dess källa?', /12[\s\u00a0\u202f]345,67/);
        break;
      case 'open-source': {
        for (const answer of [english, swedish]) {
          const link = answer.sources.find(source => source.link)?.link;
          assert(link?.startsWith('/') && !link.startsWith('//'), 'The cash answer did not expose a local source link.');
          const source = await request('GET', link, { subject: fixture.requesterSubject });
          assert.equal(source.companyId, fixture.companyId);
          assert.equal(source.amount, 12345.67);
          assert.equal(Date.parse(source.asOfUtc), cashTime);
        }
        break;
      }
      case 'ask-ambiguous': {
        const candidates = baseline.invoices.filter(row => row.companyId === fixture.companyId);
        assert.deepEqual(candidates.map(row => row.invoiceNumber).sort(), ['INV-1042-A', 'INV-1042-B']);
        const result = await invoice('INV-1042');
        assert.equal(result.state, 'needs_clarification', result.safeExplanation);
        assert.equal(result.answer, null);
        assert.equal(result.steps.length, 0);
        break;
      }
      case 'clarify':
        await ownInvoice('INV-1042-A');
        assert.deepEqual((await state()).invoices, baseline.invoices);
        break;
      case 'read-own':
        await ownInvoice(fixture.invoiceId);
        break;
      case 'request-foreign': {
        const result = await invoice(fixture.foreignInvoiceId);
        assert.equal(result.state, 'needs_clarification', result.safeExplanation);
        assert.equal(result.answer, null);
        assert.equal(result.steps.length, 0);
        assert.doesNotMatch(JSON.stringify(result), /Getright Foreign Canary|987654\.32/);
        break;
      }
      case 'verify-isolation':
        assert.deepEqual((await state()).invoices, baseline.invoices);
        break;
      case 'recommend': {
        const result = await ask('Recommend a category for this cloud software subscription transaction.', {
          context: transactionContext()
        });
        await show(result.answer?.summary ?? `${result.reasonCode}: ${result.safeExplanation}`);
        assert.equal(result.state, 'completed', result.safeExplanation);
        assert.equal(result.steps[0].toolName, 'recommend_transaction_category');
        assert.equal(result.steps[0].validatedOutput?.data?.recommendation?.transactionId, fixture.transactionId);
        assert.equal(result.steps[0].validatedOutput?.data?.recommendation?.recommendedCategory, 'software');
        break;
      }
      case 'verify-unchanged': {
        const current = await state();
        assert.equal(current.category, 'uncategorized');
        assert.equal(current.approvals.length, 0);
        assert(current.attempts.every(attempt => attempt.toolName === 'recommend_transaction_category'));
        assert.deepEqual({ ...current, attempts: [] }, { ...baseline, attempts: [] });
        break;
      }
      case 'request':
        await requestApproval();
        break;
      case 'approve':
        applied = await approve();
        assert.equal(applied.category, 'software');
        assert.deepEqual(applied.attempts.map(attempt => [attempt.id, attempt.status]), [[pending.executionId, 'Executed']]);
        break;
      case 'replay':
        await deliverDecision();
        assert.deepEqual(await state(), applied);
        break;
      case 'change-target':
        await request('POST', `${fixturePath}/change-target`, { statuses: [204] });
        applied = await state();
        assert.equal(applied.category, 'travel');
        assert.equal(applied.approvals[0].status, 'Pending');
        break;
      case 'attempt-approval': {
        const current = await approve();
        assert.equal(current.category, 'travel');
        assert.deepEqual({ ...current, attempts: [], approvals: [] }, { ...applied, attempts: [], approvals: [] });
        assert.equal(current.approvals[0].status, 'Stale');
        assert.deepEqual(current.attempts.map(attempt => [attempt.id, attempt.status]), [[pending.executionId, 'Denied']]);
        assert.match(current.attempts[0].denialReason ?? '', /target.*stale/);
        break;
      }
      default:
        throw new Error(`No Finance Agent automation for ${scenario}/${step}.`);
    }
  };
}
