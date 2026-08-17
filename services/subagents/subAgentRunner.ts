import type { SubAgentDefinition } from '../../types';
import type { SubAgentProvider } from './providers/types';
import { subAgentProviderRegistry, ProviderNotConfiguredError, type SubAgentProviderRegistry } from './providers/providerRegistry';
import { buildSubAgentPrompt } from './subAgentPrompt';
import { InvalidSubAgentResultError, parseSubAgentResult } from './subAgentResult';
import type { SubAgentRun, SubAgentTaskContract, SubAgentTaskResult } from './types';

export interface ExecuteSubAgentTaskOptions { signal?: AbortSignal; provider?: SubAgentProvider; registry?: SubAgentProviderRegistry }

const failed = (task: SubAgentTaskContract, code: string, detail: string): SubAgentTaskResult => ({
  taskId: task.taskId, subAgentId: task.subAgentId, status: 'failed', summary: 'SubAgent task failed', errorCode: code, errorDetail: detail,
});

const aborted = (task: SubAgentTaskContract): SubAgentTaskResult => ({
  taskId: task.taskId, subAgentId: task.subAgentId, status: 'aborted', summary: 'SubAgent task aborted', errorCode: 'ABORTED', errorDetail: 'Task was aborted',
});

export async function executeSubAgentTask(definition: SubAgentDefinition, task: SubAgentTaskContract, options: ExecuteSubAgentTaskOptions = {}): Promise<SubAgentTaskResult> {
  if (definition.id !== task.subAgentId || !task.taskId || !task.parentAgentId) return failed(task, 'INVALID_TASK_CONTRACT', 'Task ownership or identifiers are invalid');
  if (!definition.isEnabled) return failed(task, 'SUBAGENT_DISABLED', 'SubAgent is disabled');
  if (options.signal?.aborted) return aborted(task);
  if (options.provider && options.provider.id !== definition.provider) {
    return failed(task, 'PROVIDER_MISMATCH', `Configured provider ${definition.provider} does not match injected provider ${options.provider.id}`);
  }
  let provider: SubAgentProvider;
  try { provider = options.provider ?? (options.registry ?? subAgentProviderRegistry).getProvider(definition.provider); }
  catch (error) { return failed(task, error instanceof ProviderNotConfiguredError ? error.code : 'PROVIDER_ERROR', error instanceof Error ? error.message : String(error)); }
  try {
    const response = await provider.generate({ model: definition.model, systemInstruction: definition.systemInstruction, prompt: buildSubAgentPrompt(task), thinkingBudget: definition.thinkingBudget, maxOutputTokens: definition.maxOutputTokens, signal: options.signal });
    if (options.signal?.aborted) return aborted(task);
    if (response.provider !== provider.id || response.model !== definition.model || !Number.isFinite(response.latencyMs) || response.latencyMs < 0) {
      return failed(task, 'PROVIDER_RESPONSE_MISMATCH', 'Provider response identity, model, or latency does not match the configured execution');
    }
    const result = parseSubAgentResult(response.text, task);
    return { ...result, metadata: { provider: provider.id, model: definition.model, latencyMs: response.latencyMs } };
  } catch (error) {
    if (options.signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) return aborted(task);
    return failed(task, error instanceof InvalidSubAgentResultError ? error.code : 'PROVIDER_ERROR', error instanceof Error ? error.message : String(error));
  }
}

export interface SubAgentRunHandle { run: SubAgentRun; controller: AbortController; execute(): Promise<SubAgentTaskResult> }

export const createSubAgentRun = (definition: SubAgentDefinition, task: SubAgentTaskContract, options: ExecuteSubAgentTaskOptions & { parentSessionId?: string } = {}): SubAgentRunHandle => {
  const controller = new AbortController();
  const run: SubAgentRun = { runId: crypto.randomUUID(), parentSessionId: options.parentSessionId, parentAgentId: task.parentAgentId, subAgentId: task.subAgentId, taskId: task.taskId, status: 'pending' };
  const onAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  return { run, controller, async execute() {
    run.status = 'running'; run.startedAt = Date.now();
    const result = await executeSubAgentTask(definition, task, { ...options, signal: controller.signal });
    run.status = result.status; run.completedAt = Date.now();
    options.signal?.removeEventListener('abort', onAbort);
    return result;
  } };
};
