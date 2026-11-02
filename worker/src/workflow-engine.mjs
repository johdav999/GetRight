import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const files = ['workflow-plan.mjs', 'workflow.mjs', 'workflow-engine.mjs', 'runner.mjs', 'writerapp.mjs', 'virtual-company.mjs',
  '../package-lock.json', '../hosts/virtual-company/Program.cs', '../../src/Getright.Dashboard/wwwroot/uat-fixture.html', '../../src/Getright.Dashboard/wwwroot/uat-fixture.js'];
export async function currentWorkflowEngineDigest() {
  const hash = createHash('sha256');
  for (const file of files) { hash.update(file); hash.update(await readFile(new URL(file, import.meta.url))); }
  return hash.digest('hex');
}
export const workflowEngineDigest = await currentWorkflowEngineDigest();
