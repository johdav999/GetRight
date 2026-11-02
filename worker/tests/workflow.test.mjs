import assert from 'node:assert/strict';
import test from 'node:test';
import { applicationPath, validateWorkflow } from '../src/workflow-plan.mjs';
import { workflowEngineDigest } from '../src/workflow-engine.mjs';

const definition = { applicationId: 'getright', steps: [{ id: 'step-1' }, { id: 'step-2' }] };
const plan = () => ({ version: 1, fixture: 'getright-note', entryPath: '/uat-fixture.html?fixture={{fixtureId}}', reviewPath: '/uat-fixture.html', steps: [
  { stepId: 'step-1', actions: [{ kind: 'fill', selector: '#title', value: 'UAT {{unique}}' }, { kind: 'expect-value', selector: '#title', value: 'UAT {{unique}}' }] },
  { stepId: 'step-2', actions: [{ kind: 'click', selector: '#save' }, { kind: 'expect-text', selector: '#confirmation', value: 'saved successfully' }] },
] });
test('workflow requires every frozen step with observable assertions and a matching isolated fixture', () => {
  assert.equal(validateWorkflow(definition, JSON.stringify(plan())).steps.length, 2);
  for (const change of [p => p.steps.reverse(), p => p.steps.pop(), p => { p.fixture = 'virtual-company-test-company'; }, p => { p.steps[0].actions = [{ kind: 'click', selector: '#save' }]; }]) {
    const changed = plan(); change(changed); assert.throws(() => validateWorkflow(definition, JSON.stringify(changed)));
  }
  assert.match(workflowEngineDigest, /^[a-f0-9]{64}$/);
});
test('workflow refuses code, commands, external paths and undocumented fields before executing anything', () => {
  for (const kind of ['evaluate', 'request', 'shell', 'waitForTimeout', 'javascript']) {
    const changed = plan(); changed.steps[0].actions.unshift({ kind, selector: 'body' });
    assert.throws(() => validateWorkflow(definition, JSON.stringify(changed)), /Unsupported/);
  }
  for (const value of ['https://example.com', '//example.com', '/\\example.com', 'javascript:alert(1)', '/\nunsafe']) assert.throws(() => applicationPath(value));
  const unknown = plan(); unknown.steps[0].actions[0].code = 'process.exit()'; assert.throws(() => validateWorkflow(definition, JSON.stringify(unknown)));
  const missing = plan(); missing.steps[0].actions[0].value = '{{unknown}}'; assert.throws(() => validateWorkflow(definition, JSON.stringify(missing)), /placeholder/);
});
