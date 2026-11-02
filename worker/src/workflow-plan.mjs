const fixtureByApp = { getright: 'getright-note', writerapp: 'writerapp-document', 'virtual-company': 'virtual-company-test-company' };
const kinds = new Set(['goto', 'reload', 'fill', 'click', 'check', 'uncheck', 'select', 'expect-visible', 'expect-hidden', 'expect-text', 'expect-value', 'expect-checked', 'expect-unchecked', 'expect-enabled', 'expect-disabled', 'expect-count', 'expect-url']);
const placeholders = new Set(['fixtureId', 'unique', 'companyId', 'documentId', 'email']);
const object = (value, keys) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new Error('The workflow contains an unsupported object or field.');
};
export function applicationPath(value, templates = true) {
  if (typeof value !== 'string' || !value.length || value.length > 1000 || !value.startsWith('/') || value.startsWith('//') || /[\\\r\n]/.test(value) || (!templates && value.includes('{{')) || new URL(value, 'http://127.0.0.1').origin !== 'http://127.0.0.1') throw new Error('Use a relative path on the isolated application origin.');
}
export function validateWorkflow(test, json) {
  if (typeof json !== 'string' || !json.trim() || json.length > 65536) throw new Error('The workflow plan must contain bounded JSON.');
  const plan = JSON.parse(json);
  object(plan, ['version', 'fixture', 'entryPath', 'reviewPath', 'steps']);
  if (plan.version !== 1 || plan.fixture !== fixtureByApp[test.applicationId] || !Array.isArray(plan.steps) || plan.steps.length !== test.steps.length) throw new Error('The workflow must use this application fixture and every frozen test step.');
  applicationPath(plan.entryPath); applicationPath(plan.reviewPath, false);
  let count = 0;
  for (const [index, step] of plan.steps.entries()) {
    object(step, ['stepId', 'actions']);
    if (step.stepId !== test.steps[index].id || !Array.isArray(step.actions) || step.actions.length < 1 || step.actions.length > 30 || !step.actions.some(action => typeof action?.kind === 'string' && action.kind.startsWith('expect-'))) throw new Error('Each original step needs bounded actions and an observable assertion.');
    count += step.actions.length;
    for (const action of step.actions) {
      object(action, ['kind', 'selector', 'value']);
      if (!kinds.has(action.kind)) throw new Error('Unsupported workflow action. Code, commands and arbitrary HTTP requests are forbidden.');
      if (['goto', 'expect-url'].includes(action.kind)) applicationPath(action.value);
      else if (action.kind !== 'reload' && (typeof action.selector !== 'string' || !action.selector.trim() || action.selector.length > 500)) throw new Error('Provide a bounded element selector.');
      if (action.value != null && (typeof action.value !== 'string' || action.value.length > 8000)) throw new Error('An action value is invalid.');
      if (['fill', 'select', 'expect-text', 'expect-value'].includes(action.kind) && typeof action.value !== 'string') throw new Error('This action requires a text value.');
      if (action.kind === 'expect-count' && (!/^\d+$/.test(action.value ?? '') || Number(action.value) > 1000)) throw new Error('Use an element count between 0 and 1000.');
      for (const value of [action.selector, action.value, plan.entryPath]) {
        if (typeof value !== 'string') continue;
        for (const match of value.matchAll(/\{\{(.*?)\}\}/g)) if (!placeholders.has(match[1])) throw new Error(`Unknown fixture placeholder: ${match[1]}`);
      }
    }
  }
  if (count > 120) throw new Error('A workflow supports at most 120 actions.');
  return plan;
}

export const workflowContract = `Write JSON only at the specified artifact path. Format:
{"version":1,"fixture":"FIXTURE","entryPath":"RELATIVE_PATH","reviewPath":"RELATIVE_PATH_WITHOUT_PLACEHOLDERS","steps":[{"stepId":"ORIGINAL_STEP_ID","actions":[{"kind":"ACTION","selector":"CSS_OR_PLAYWRIGHT_SELECTOR_OR_NULL","value":"TEXT_OR_NULL"}]}]}.
Implement every original step ID exactly once in order. Every step requires a meaningful expect-* assertion of its stated expected result; an empty step or a generic body-visible check is not an implementation.
Allowed kinds: goto, reload, fill, click, check, uncheck, select, expect-visible, expect-hidden, expect-text (contains text), expect-value (exact), expect-checked, expect-unchecked, expect-enabled, expect-disabled, expect-count (value is a nonnegative integer string <=1000), expect-url (exact origin-relative path).
Selectors are Playwright selectors limited to 500 characters. Values are strings <=8000 characters, null when unused. At most 30 actions per step and 120 total. Plans are <=65536 characters.
Only origin-relative paths beginning with / are allowed. No external URLs, JavaScript, evaluate, arbitrary requests, sleeps, shell commands, auth headers, filesystem paths, fixture mutation code or new action kinds.
Available string placeholders: {{fixtureId}}, {{unique}}, {{companyId}}, {{documentId}}, {{email}}. Use only ones available for this fixture. Their values are generated independently for each run; never hard-code resource IDs.
The worker handles runtime/build/account verification, isolated fixture setup, screenshots and tracing. entryPath is opened AFTER setup. reviewPath opens the entry surface without creating a fixture and cannot contain placeholders.
Fixtures: getright-note starts with an empty local-storage note at /uat-fixture.html?fixture={{fixtureId}}; writerapp-document starts with a fresh saved document in the editor (documentId is available); virtual-company-test-company creates/selects a fresh synthetic company, prepares a disconnected draft sender and employee membership, and starts on /settings/test-company?companyId={{companyId}} with NO email permissions enabled.
The Virtual Company fixture does not populate accounting, deliver or receive email, ingest invoices, enable providers, run hosted background jobs, or configure external credentials. Do not claim those prerequisites exist. The WriterApp fixture does not configure AI providers or invitation recipients.
If the case cannot be honestly implemented using this fixture and action vocabulary, write {"blockedReason":"precise missing fixture/capability"} instead. Never weaken expected outcomes, replace the case with a different workflow, or manufacture passing observations.`;
