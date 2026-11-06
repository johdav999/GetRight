import { executeRun as executeAdapterRun } from './runner.mjs';
import { api } from './settings.mjs';
import { currentWorkflowEngineDigest, workflowEngineDigest } from './workflow-engine.mjs';
import { runtimeContractVersion, runtimeLifecycle } from './runtime-configuration.mjs';
import { withRunCompletion } from './run-completion.mjs';
import { configuredWorkflowDigest, configuredWorkflowVersion, currentConfiguredWorkflowDigest, validateConfiguredRun } from './configured-workflow.mjs';
import { executeConfiguredRun } from './configured-runner.mjs';

const integrationContractVersion = 1;
export const workerExecution = Object.freeze({ runConfigurationVersion: 1, engineDigest: workflowEngineDigest, runtimeContractVersion, configuredWorkflowVersion, configuredWorkflowDigest, integrationContractVersion });
export const workerClaim = Object.freeze({ runConfigurationVersion: workerExecution.runConfigurationVersion, workflowEngineDigest, supportsStepControl: true, runtimeContractVersion, configuredWorkflowVersion, configuredWorkflowDigest, integrationContractVersion, buildRecipeVersion: 1 });

const fixtureOwners = new Map([['getright-save-note', 'getright'], ['writerapp-create-save', 'writerapp'], ['virtual-company-test-setup', 'virtual-company']]);

// Keep this protocol boundary outside the verified workflow interpreter. The
// three existing fixture adapters and their verified engine digest are unchanged.
export async function executeRun(claim, configuration) {
  const { run, lease } = claim;
  if (!/^[a-f0-9]{32}$/.test(run.id) || run.fixtureId !== `uat-${run.id}`) throw new Error('Invalid run identity.');
  const snapshot = run.configuration;
  let configuredPlan;
  if (snapshot != null) {
    try {
      const { manifest, adapter } = snapshot;
      const configured = adapter?.id === 'configured-v2';
      if (snapshot.version !== workerExecution.runConfigurationVersion || manifest?.schemaVersion !== 1 ||
          !Number.isInteger(manifest.revision) || manifest.revision < 1 || manifest.applicationId !== run.applicationId ||
          (manifest.fixtureAdapter === 'configured-v2' ?
            !configured || !manifest.runtime || !run.target || snapshot.dashboardBuild != null :
            fixtureOwners.get(manifest.fixtureAdapter) !== run.applicationId) ||
          adapter?.version !== (configured ? configuredWorkflowVersion : 1) || adapter.id !== run.testSnapshot.adapter ||
          (!configured && adapter.id !== manifest.fixtureAdapter && adapter.id !== 'declarative-v1') ||
          !manifest.adapters?.some(binding => binding.id === adapter.id && binding.version === adapter.version) ||
          !manifest.capabilities?.includes('test') ||
          run.worker?.runConfigurationVersion !== workerExecution.runConfigurationVersion || run.worker?.engineDigest !== workflowEngineDigest ||
          (manifest.runtime != null && (manifest.runtime.version !== runtimeContractVersion || run.worker.runtimeContractVersion !== runtimeContractVersion)) ||
          (snapshot.requiredEngineDigest != null && snapshot.requiredEngineDigest !== workflowEngineDigest) ||
          await currentWorkflowEngineDigest() !== workflowEngineDigest)
        throw new Error('The frozen application configuration is incompatible with this worker. Restart with a compatible worker.');
      if (configured) {
        if (run.worker.configuredWorkflowVersion !== configuredWorkflowVersion || run.worker.configuredWorkflowDigest !== configuredWorkflowDigest ||
            await currentConfiguredWorkflowDigest() !== configuredWorkflowDigest)
          throw new Error('The configured workflow engine does not match this claim. Restart the worker.');
        configuredPlan = validateConfiguredRun(run);
      }
      if (snapshot.dashboardBuild != null && (await api(configuration.dashboardUrl, '/api/health')).version !== snapshot.dashboardBuild)
        throw new Error('The dashboard build changed after this demo was queued. Queue a fresh run.');
    } catch (error) {
      return api(configuration.dashboardUrl, `/api/runs/${run.id}/complete`, { lease, status: 'failed', steps: [], error: error.message });
    }
  }
  if (configuredPlan) return executeConfiguredRun(claim, configuration, configuredPlan);
  if (snapshot?.manifest.runtime) {
    const route = `/api/runs/${run.id}`;
    let lifecycle;
    let finalized;
    const finalize = result => finalized ??= lifecycle.finish(result).finally(() => lifecycle.close());
    try {
      lifecycle = runtimeLifecycle(claim, configuration);
      configuration.signal?.throwIfAborted();
      const state = await api(configuration.dashboardUrl, `${route}/heartbeat`, { lease });
      if (state.cancelRequested) throw new Error('Cancelled before runtime setup.');
      await lifecycle.setup();
    } catch (error) {
      const result = { lease, status: 'failed', steps: [], error: error.message };
      return api(configuration.dashboardUrl, `${route}/complete`, lifecycle ? await finalize(result) : result);
    }
    try {
      return await withRunCompletion(configuration.dashboardUrl, `${route}/complete`, lease, finalize,
        () => executeAdapterRun(claim, configuration));
    } finally {
      // A lost worker connection can prevent result submission. Still attempt
      // cleanup of receipts owned by this process, under the same safety checks.
      await finalize({ lease, status: 'interrupted', steps: [] });
    }
  }
  return executeAdapterRun(claim, configuration);
}
