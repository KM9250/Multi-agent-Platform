import {
  BROWSER_RISK_RULES, BrowserSandboxController, InMemoryBrowserPocDriver, createBrowserPocExecutor,
  createCoordinationRunner, createWorkflow, createRunnerEvent, InMemoryCoordinationRunnerStore,
  InMemoryRunnerPendingActionStore, InMemoryRunnerEvidenceStore,
} from '../services/coordination/index.ts';
import type { BrowserPocCommand, CoordinationEventType, CoordinationPolicy, RunnerActionExecutor, RunnerPlanRequest, RunnerVerifyRequest } from '../services/coordination/index.ts';
export const executionContext = { workflowRunId: 'run', sessionId: 'session', taskId: 'task' };
export const proposal = (command: BrowserPocCommand) => { const { operation, ...args } = command; return { executorId: 'browser', operation, arguments: args }; };
export function browserFixture(command: BrowserPocCommand = { operation: 'read' }, riskRules: CoordinationPolicy['riskRules'] = {}, runId = 'run') {
  let serial = 0;
  const ids = { nextId: (kind: string) => `${kind}-${++serial}` }, clock = { now: () => 10 };
  const controller = new BrowserSandboxController(), driver = new InMemoryBrowserPocDriver(controller);
  const evidenceStore = new InMemoryRunnerEvidenceStore(ids);
  const executor = createBrowserPocExecutor({ driver, evidenceStore, ids, clock });
  const calls = { plan: 0, execute: 0, verify: 0 };
  const requests: { plans: RunnerPlanRequest[]; verifies: RunnerVerifyRequest[] } = { plans: [], verifies: [] };
  const currentCommand = { value: command };
  const snapshot = createWorkflow({ runId, roomId: 'room', goal: 'Original user goal', acceptanceCriteria: ['done'], supervisorAgentId: 'supervisor',
    participantAgentIds: ['supervisor'], executionMode: 'supervised_autonomous', now: 1, policy: {
      policyId: 'browser-policy', version: '1', schemaVersion: 1, riskRules: { ...BROWSER_RISK_RULES, ...riskRules },
      budgets: { maxWallTimeMs: 100000, maxRounds: 20, maxLlmCalls: 100, maxInputTokens: 1000, maxOutputTokens: 1000, maxEstimatedCost: 10, maxConsecutiveErrors: 20, maxNoProgressCycles: 20 },
      completionRules: { commitAuthority: 'supervisor', requireAllAcceptanceCriteria: true }, schedulerRules: { sameModelConcurrency: 1 },
      retryRules: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
    } });
  const store = new InMemoryCoordinationRunnerStore([snapshot]), pendingActions = new InMemoryRunnerPendingActionStore();
  const response = <T>(value: T) => ({ value, provider: 'fake', model: 'test', latencyMs: 0,
    usage: { llmCalls: 1, inputTokens: 1, outputTokens: 1, estimatedCost: 0 } });
  const tracked: RunnerActionExecutor = { id: 'browser', prepare: p => executor.prepare(p), execute: (a, c) => { calls.execute++; return executor.execute(a, c); } };
  const deps = { store, pendingActions, evidenceStore, ids, clock, executors: { get: (id: string) => id === 'browser' ? tracked : undefined },
    supervisorProvider: {
      async plan(request: RunnerPlanRequest) { calls.plan++; requests.plans.push(request); return response({ kind: 'execute' as const, objective: 'Safe objective', action: proposal(currentCommand.value) }); },
      async verify(request: RunnerVerifyRequest) { calls.verify++; requests.verifies.push(request); return response({ taskOutcome: 'PASS' as const, summary: 'Checked', criteria: [] }); },
    } };
  const runner = createCoordinationRunner(deps);
  const get = () => store.getSnapshot(runId);
  const add = (type: CoordinationEventType, payload: unknown) => store.append(createRunnerEvent(get(), type, payload, clock, ids));
  const resume = (reference?: string, type = 'user') => add('WorkflowResumed', { authorization: { type, reference } });
  return { ids, clock, controller, driver, evidenceStore, executor, tracked, store, pendingActions, runner, deps, currentCommand, calls, requests, get, add, resume, runId };
}
