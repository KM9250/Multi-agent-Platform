import type { Agent, SubAgentDefinition } from '../../types';
import type { SubAgentProviderRegistry } from './providers/providerRegistry';
import { createSubAgentRun } from './subAgentRunner';
import type { SubAgentTaskInput, SubAgentTaskResult } from './types';

export interface PrivateSubAgentReport { workerId: string; workerName: string; status: 'completed'; summary: string; result?: unknown; evidence?: unknown[]; unresolved?: string[]; confidence?: number }
export interface SubAgentRunDiagnostic { parentAgentName: string; workerName: string; status: 'completed' | 'failed' | 'aborted'; latencyMs: number; confidence?: number; errorCode?: string }
export interface FixedSubAgentPipelineOutcome { status: 'not_configured' | 'completed' | 'partial' | 'failed' | 'aborted'; reports: PrivateSubAgentReport[]; diagnostics: SubAgentRunDiagnostic[] }
export interface PipelineOptions { sessionId: string; inputs: SubAgentTaskInput[]; signal?: AbortSignal; registry?: SubAgentProviderRegistry }

const contractFor = (agent: Agent, worker: SubAgentDefinition, inputs: SubAgentTaskInput[], index: number) => ({ taskId: `${index}-${crypto.randomUUID()}`, parentAgentId: agent.id, subAgentId: worker.id, taskType: worker.capabilities?.[0] ?? 'general_analysis', goal: worker.description || 'Execute the configured private worker role for the parent agent.', inputs, constraints: ['Use only the explicit task inputs.', 'Do not impersonate the parent persona.', 'Do not claim use of tools not provided by runtime.'], acceptanceCriteria: ['Return a valid structured SubAgentTaskResult.'] });

export async function runFixedSerialPipeline(agent: Agent, options: PipelineOptions): Promise<FixedSubAgentPipelineOutcome> {
  const workers = agent.subAgentPolicy?.mode === 'fixed_serial' ? (agent.subAgents ?? []).filter(worker => worker.isEnabled && (worker.maxCallsPerTurn ?? 1) > 0) : [];
  if (!workers.length) return { status: 'not_configured', reports: [], diagnostics: [] };
  const reports: PrivateSubAgentReport[] = []; const diagnostics: SubAgentRunDiagnostic[] = [];
  for (let index = 0; index < workers.length; index++) {
    const worker = workers[index];
    const previousInputs: SubAgentTaskInput[] = reports.map((report, reportIndex) => ({ name: `previous_subagent_result_${reportIndex + 1}`, content: JSON.stringify(report), mimeType: 'application/json' }));
    const task = contractFor(agent, worker, [...options.inputs, ...previousInputs], index);
    const result: SubAgentTaskResult = await createSubAgentRun(worker, task, { parentSessionId: options.sessionId, signal: options.signal, registry: options.registry }).execute();
    diagnostics.push({ parentAgentName: agent.name, workerName: worker.name, status: result.status, latencyMs: result.metadata?.latencyMs ?? 0, confidence: result.confidence, errorCode: result.errorCode });
    if (result.status === 'aborted') return { status: 'aborted', reports, diagnostics };
    if (result.status === 'failed') return { status: reports.length ? 'partial' : 'failed', reports, diagnostics };
    reports.push({ workerId: worker.id, workerName: worker.name, status: 'completed', summary: result.summary, result: result.result, evidence: result.evidence, unresolved: result.unresolved, confidence: result.confidence });
  }
  return { status: 'completed', reports, diagnostics };
}

export class GenerationSubAgentCache {
  private cache = new Map<string, Promise<FixedSubAgentPipelineOutcome>>();
  private diagnosticsEmitted = new Set<string>();
  prepare(agent: Agent, options: PipelineOptions) { const key = `${options.sessionId}:${agent.id}`; const found = this.cache.get(key); if (found) return found; const value = runFixedSerialPipeline(agent, options); this.cache.set(key, value); return value; }
  async prepareForDiagnostics(agent: Agent, options: PipelineOptions): Promise<{ outcome: FixedSubAgentPipelineOutcome; diagnosticsToDisplay: SubAgentRunDiagnostic[] }> {
    const key = `${options.sessionId}:${agent.id}`;
    const outcome = await this.prepare(agent, options);
    if (this.diagnosticsEmitted.has(key)) return { outcome, diagnosticsToDisplay: [] };
    this.diagnosticsEmitted.add(key);
    return { outcome, diagnosticsToDisplay: outcome.diagnostics };
  }
  clear() { this.cache.clear(); this.diagnosticsEmitted.clear(); }
}
